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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' });
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

  const body = await req.text();
  const sig = req.headers.get('stripe-signature')!;

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
  } catch (err) {
    return json({ error: `Webhook error: ${err.message}` }, 400);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    const { userId, email } = session.metadata ?? {};

    if (!userId || !email) return json({ error: 'Missing metadata' }, 400);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SB_SERVICE_ROLE_KEY')!,
    );

    // Récupère les infos d'onboarding du user (business_name, sms_sender) depuis auth metadata
    let businessName: string | null = null;
    let smsSender: string | null = null;
    try {
      const { data: userData } = await supabase.auth.admin.getUserById(userId);
      const meta = userData?.user?.user_metadata ?? {};
      businessName = meta.business_name || meta.company_name || null;
      smsSender = meta.sms_sender || null;
    } catch (err) {
      console.error('Failed to fetch user metadata:', err);
    }

    // Mettre à jour le profil user avec le statut payé + perso SMS
    const { error } = await supabase
      .from('profiles')
      .upsert({
        id: userId,
        email,
        stripe_customer_id: session.customer as string,
        stripe_subscription_id: session.subscription as string,
        plan: session.metadata?.plan ?? 'starter',
        status: 'active',
        business_name: businessName,
        sms_sender: smsSender,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      console.error('Supabase error:', error);
      return json({ error: error.message }, 500);
    }

    // Notifier l'admin pour qu'il achète + assigne un N° Telnyx à ce client
    // (fire-and-forget : on n'attend pas la réponse pour ne pas bloquer Stripe)
    try {
      const resendKey  = Deno.env.get('RESEND_API_KEY');
      const adminEmail = Deno.env.get('ADMIN_EMAIL') ?? 'contact@replyit.fr';
      if (resendKey) {
        const sql = `UPDATE profiles SET telnyx_number = '+33XXX' WHERE email = '${email}';`;
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'ReplyIt <noreply@mail.replyit.fr>',
            to: [adminEmail],
            subject: `🆕 Nouveau client payant : ${businessName || email}`,
            html: `
              <h2>Nouveau client à provisionner</h2>
              <p>Un client vient de payer son abonnement Stripe. Action requise :</p>
              <ol>
                <li>Acheter un numéro Telnyx FR (Mission Control → Numbers)</li>
                <li>L'assigner à l'app Voice "ReplyIt"</li>
                <li>Exécuter le SQL ci-dessous dans Supabase</li>
              </ol>
              <h3>Infos client</h3>
              <ul>
                <li><strong>Email</strong> : ${email}</li>
                <li><strong>Entreprise</strong> : ${businessName || '—'}</li>
                <li><strong>Sender SMS</strong> : ${smsSender || '—'}</li>
                <li><strong>Plan</strong> : ${session.metadata?.plan ?? 'starter'}</li>
                <li><strong>User ID</strong> : ${userId}</li>
              </ul>
              <h3>SQL à exécuter (remplacer +33XXX)</h3>
              <pre style="background:#f1f5f9;padding:12px;border-radius:6px;font-size:13px;">${sql}</pre>
              <p style="color:#64748b;font-size:13px;">Le client voit "Numéro en cours d'attribution" sur son dashboard jusqu'à ce que tu fasses cette opération.</p>
            `,
          }),
        });
      }
    } catch (err) {
      console.error('Failed to send admin notification:', err);
      // On n'échoue pas le webhook pour autant : le profile est créé, c'est l'essentiel
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object as Stripe.Subscription;
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SB_SERVICE_ROLE_KEY')!,
    );

    await supabase
      .from('profiles')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('stripe_subscription_id', subscription.id);
  }

  return json({ received: true });
});
