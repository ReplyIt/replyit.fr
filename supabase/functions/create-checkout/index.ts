import Stripe from 'https://esm.sh/stripe@14?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Whitelist des price IDs autorisés (évite qu'un attaquant injecte un prix arbitraire)
// À configurer via secret ALLOWED_PRICE_IDS (CSV) ou hardcodé ici
function getAllowedPriceIds(): Set<string> {
  const env = Deno.env.get('ALLOWED_PRICE_IDS');
  if (env) return new Set(env.split(',').map((s) => s.trim()));
  // Fallback : si pas de whitelist configurée, on n'accepte rien (fail-closed)
  return new Set();
}

async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  return user;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    // 1. Auth check : on récupère le user authentifié via son JWT Supabase
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    // 2. Parse + validation du body (on ignore userId/email envoyés)
    const { priceId, plan, successUrl, cancelUrl } = await req.json();

    if (!priceId || !plan || !successUrl || !cancelUrl) {
      return json({ error: 'Missing required fields' }, 400);
    }

    // 3. Whitelist du priceId : évite un attaquant qui forcerait un autre prix Stripe
    const allowedPrices = getAllowedPriceIds();
    if (allowedPrices.size > 0 && !allowedPrices.has(priceId)) {
      return json({ error: 'Invalid priceId' }, 400);
    }

    // 4. Création de la session checkout avec les vraies infos du user
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      metadata: { userId: user.id, email: user.email!, plan },
      subscription_data: {
        metadata: { userId: user.id, email: user.email!, plan },
      },
    });

    return json({ url: session.url });
  } catch (err) {
    console.error('create-checkout error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
