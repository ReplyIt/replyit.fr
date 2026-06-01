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

    // Récupère les infos d'onboarding du user (business_name + mobile de forward) depuis auth metadata
    let businessName: string | null = null;
    let forwardToPhone: string | null = null;
    try {
      const { data: userData } = await supabase.auth.admin.getUserById(userId);
      const meta = userData?.user?.user_metadata ?? {};
      businessName = meta.business_name || meta.company_name || null;
      forwardToPhone = meta.forward_to_phone || null;
    } catch (err) {
      console.error('Failed to fetch user metadata:', err);
    }

    // Mettre à jour le profil user avec le statut payé + le mobile de forward (collecté au signup)
    const profileData: Record<string, unknown> = {
      id: userId,
      email,
      stripe_customer_id: session.customer as string,
      stripe_subscription_id: session.subscription as string,
      plan: session.metadata?.plan ?? 'starter',
      status: 'active',
      business_name: businessName,
      updated_at: new Date().toISOString(),
    };
    // N'écrase PAS un forward_to_phone existant si le signup n'en a pas fourni
    // (ré-abonnement d'un ancien compte créé avant le champ mobile).
    if (forwardToPhone) profileData.forward_to_phone = forwardToPhone;

    const { error } = await supabase.from('profiles').upsert(profileData);

    if (error) {
      console.error('Supabase error:', error);
      return json({ error: error.message }, 500);
    }

    // Notifier l'admin pour qu'il achète + assigne un N° Telnyx à ce client
    const resendKey  = Deno.env.get('RESEND_API_KEY');
    const adminEmail = Deno.env.get('ADMIN_EMAIL') ?? 'contact@replyit.fr';
    console.log('Admin notification — resendKey present:', !!resendKey, 'adminEmail:', adminEmail);

    if (!resendKey) {
      console.warn('RESEND_API_KEY missing, skipping admin email');
    } else {
      try {
        const sql = `UPDATE profiles SET telnyx_number = '+33XXX' WHERE email = '${email}';`;
        const resendRes = await fetch('https://api.resend.com/emails', {
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
              <h2>Nouveau client à provisionner (modèle numéro dédié)</h2>
              <p>Un client vient de payer son abonnement Stripe. Action requise :</p>
              <ol>
                <li>Acheter un numéro Telnyx FR (Mission Control → Numbers)</li>
                <li>L'assigner à l'app <strong>TeXML "ReplyIt TeXML"</strong> (PAS Call Control)</li>
                <li>Exécuter le SQL ci-dessous (assigne le numéro Telnyx au client)</li>
                <li>Dire au client : enregistrer ce numéro Telnyx dans ses contacts + vérifier que son mobile sonne ~18s avant sa messagerie (sinon ajuster le timeout)</li>
              </ol>
              <h3>Infos client</h3>
              <ul>
                <li><strong>Email</strong> : ${email}</li>
                <li><strong>Entreprise</strong> : ${businessName || '—'}</li>
                <li><strong>Mobile (forward, déjà en DB)</strong> : ${forwardToPhone || '⚠️ MANQUANT'}</li>
                <li><strong>Plan</strong> : ${session.metadata?.plan ?? 'starter'}</li>
                <li><strong>User ID</strong> : ${userId}</li>
              </ul>
              <h3>SQL à exécuter (remplacer +33XXX par le numéro Telnyx acheté)</h3>
              <pre style="background:#f1f5f9;padding:12px;border-radius:6px;font-size:13px;">${sql}</pre>
              <p style="color:#64748b;font-size:13px;">Le client voit "Numéro en cours d'attribution" sur son dashboard jusqu'à ce que tu fasses cette opération. Le mobile de forward est déjà rempli (collecté au signup).</p>
            `,
          }),
        });
        const resendBody = await resendRes.text();
        console.log('Resend response:', resendRes.status, resendBody);
        if (!resendRes.ok) {
          console.error('Resend API rejected:', resendRes.status, resendBody);
        }
      } catch (err) {
        console.error('Resend fetch threw:', err);
      }
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
