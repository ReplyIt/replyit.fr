// Notifie le client par email quand son numéro ReplyIt est attribué.
// Déclenché par un Database Webhook Supabase sur UPDATE de la table `profiles`
// (quand telnyx_number passe de vide → rempli).
//
// Sécurité : header `x-notify-secret` qui doit matcher l'env NOTIFY_SECRET.
// Déploiement : supabase functions deploy notify-number-ready --no-verify-jwt

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-notify-secret',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// +33612345678 → 06 12 34 56 78 (affichage)
function formatPhone(p: string): string {
  if (!p) return p;
  let n = p.replace(/[\s.\-()]/g, '');
  if (n.startsWith('+33')) n = '0' + n.slice(3);
  if (/^0\d{9}$/.test(n)) return n.replace(/(\d{2})(?=\d)/g, '$1 ').trim();
  return p;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // Garde-fou : secret partagé (évite qu'un tiers déclenche des envois)
  const expected = Deno.env.get('NOTIFY_SECRET');
  if (expected && req.headers.get('x-notify-secret') !== expected) {
    return json({ error: 'Unauthorized' }, 401);
  }

  try {
    const payload = await req.json();
    const record = payload?.record;
    const oldRecord = payload?.old_record;
    if (!record) return json({ skipped: 'no record' });

    const before = (oldRecord?.telnyx_number ?? '').toString().trim();
    const after = (record.telnyx_number ?? '').toString().trim();

    // On envoie UNIQUEMENT quand le numéro vient d'être attribué (vide → rempli)
    if (!after || before) return json({ skipped: 'not a new assignment' });

    const email = (record.email ?? '').toString().trim();
    if (!email) return json({ skipped: 'no email' });

    const brand = (record.business_name ?? '').toString().trim();
    const numFmt = formatPhone(after);
    const hello = brand ? `Bonjour ${brand},` : 'Bonjour,';

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) {
      console.warn('RESEND_API_KEY missing, skipping email');
      return json({ skipped: 'no resend key' });
    }

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;color:#0f172a;">
        <h2 style="color:#0369a1;">🎉 Votre numéro ReplyIt est prêt !</h2>
        <p>${hello}</p>
        <p>Bonne nouvelle : votre numéro professionnel ReplyIt est <strong>activé</strong>.</p>
        <p style="font-size:1.5rem;font-weight:800;letter-spacing:0.02em;background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:14px 18px;text-align:center;color:#0369a1;">${numFmt}</p>
        <p><strong>Pour démarrer :</strong></p>
        <ol style="line-height:1.7;">
          <li>Enregistrez ce numéro dans vos contacts.</li>
          <li>Testez-le : appelez-le, laissez sonner sans décrocher → vous recevez le SMS automatique.</li>
          <li>Diffusez-le là où arrivent vos nouveaux prospects (fiche Google, cartes de visite, site, devis).</li>
        </ol>
        <p style="margin-top:24px;">
          <a href="https://replyit.fr/dashboard" style="background:#0369a1;color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:9999px;display:inline-block;">Accéder à mon tableau de bord →</a>
        </p>
        <p style="color:#64748b;font-size:13px;margin-top:24px;">À très vite,<br>L'équipe ReplyIt</p>
      </div>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'ReplyIt <noreply@mail.replyit.fr>',
        to: [email],
        subject: '🎉 Votre numéro ReplyIt est prêt',
        html,
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      console.error('Resend rejected:', res.status, body);
      return json({ error: 'Resend failed', status: res.status }, 500);
    }

    console.log('Number-ready email sent to', email, after);
    return json({ success: true, email });
  } catch (err) {
    console.error('notify-number-ready error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
