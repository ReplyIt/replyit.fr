// Telnyx TeXML webhook — Modèle NUMÉRO DÉDIÉ (Telnyx = porte d'entrée)
//
// Architecture :
//   1. Le client final appelle le numéro Telnyx du pro (= son numéro pro affiché)
//   2. Telnyx fait sonner le mobile de l'artisan via <Dial> (callerId = son numéro Telnyx)
//      avec un timeout COURT (DIAL_TIMEOUT_SEC), volontairement < timer messagerie mobile
//   3. L'artisan décroche dans le délai → conversation normale (décrochage live préservé)
//   4. Pas de réponse dans le délai → Telnyx coupe la jambe AVANT que la messagerie mobile
//      ne réponde → callback "no-answer" → SMS auto au client
//
// Stockage : Postgres (table public.calls). Migré depuis Airtable (2026-06-02).
//
// Routing par query param `step` :
//   (aucun)         → appel entrant initial → <Dial timeout> vers le mobile artisan
//   step=dialresult → callback fin de <Dial> : completed = répondu live, sinon SMS

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const FALLBACK_CLIENT_EMAIL = Deno.env.get('CLIENT_EMAIL') ?? 'template@yopmail.com';
const FALLBACK_SMS_SENDER = Deno.env.get('BREVO_SENDER') ?? 'ReplyIt';
const TALLY_FORM_URL = Deno.env.get('TALLY_FORM_URL') ?? 'https://tally.so/r/VLDjpa';

// ⚠️ URL PUBLIQUE de cette fonction, construite depuis SUPABASE_URL (env fiable).
// On NE PEUT PAS utiliser req.url : dans Supabase Edge Functions il contient l'URL
// INTERNE (host non public), ce qui rend les callbacks Telnyx injoignables.
const PUBLIC_BASE = `${Deno.env.get('SUPABASE_URL')}/functions/v1/telnyx-texml`;

// Durée de sonnerie du mobile de l'artisan avant no-answer → SMS.
// ⚠️ DOIT rester < timer messagerie du mobile de l'artisan.
const DIAL_TIMEOUT_SEC = 18;

function supabaseAdmin() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SB_SERVICE_ROLE_KEY')!,
  );
}

interface ClientProfile {
  id: string | null;
  email: string;
  businessName: string | null;
  smsTemplate: string | null;
  forwardToPhone: string | null;
}

async function getClientProfile(telnyxNumber: string | undefined): Promise<ClientProfile> {
  const fallback: ClientProfile = {
    id: null,
    email: FALLBACK_CLIENT_EMAIL,
    businessName: null,
    smsTemplate: null,
    forwardToPhone: null,
  };
  if (!telnyxNumber) return fallback;
  try {
    const { data } = await supabaseAdmin()
      .from('profiles')
      .select('id, email, business_name, sms_template, forward_to_phone')
      .eq('telnyx_number', telnyxNumber)
      .eq('status', 'active')
      .maybeSingle();
    if (!data) return fallback;
    return {
      id: data.id ?? null,
      email: data.email ?? FALLBACK_CLIENT_EMAIL,
      businessName: data.business_name,
      smsTemplate: data.sms_template,
      forwardToPhone: data.forward_to_phone,
    };
  } catch (err) {
    console.error('Client lookup failed:', err);
    return fallback;
  }
}

function buildSmsContent(profile: ClientProfile, phone: string): string {
  const tallyUrl = `${TALLY_FORM_URL}?phone=${encodeURIComponent(phone)}`;
  const brand = profile.businessName?.trim().slice(0, 30) || 'Nous';
  if (profile.smsTemplate && profile.smsTemplate.trim().length > 0) {
    const body = profile.smsTemplate.trim().replace(/\{business_name\}/g, brand);
    return `${body} ${tallyUrl}`;
  }
  const prefix = profile.businessName?.trim()
    ? `${brand} a bien reçu votre appel,`
    : `Nous avons bien reçu votre appel,`;
  return `${prefix} on vous rappelle. Précisez votre demande : ${tallyUrl}`;
}

function isFrenchPhone(phone: string): boolean {
  if (!phone) return false;
  const cleaned = phone.replace(/[\s\-\.\(\)]/g, '');
  if (/^\+33[1-9]\d{8}$/.test(cleaned)) return true;
  if (/^0[1-9]\d{8}$/.test(cleaned)) return true;
  return false;
}

// Dédup "même prospect dans la dernière heure" (Postgres).
async function isPhoneRecentlyProcessed(phone: string, clientEmail: string): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin()
    .from('calls')
    .select('id')
    .eq('phone', phone)
    .eq('client_email', clientEmail)
    .gt('occurred_at', oneHourAgo)
    .limit(1);
  if (error) {
    console.error('Postgres dedup check failed:', error);
    return false; // en cas d'erreur, on continue plutôt que de bloquer
  }
  return Array.isArray(data) && data.length > 0;
}

// Upsert atomique par call_sid (catch les retries Telnyx). Retourne true si NOUVELLE ligne.
// `ignoreDuplicates: true` → ON CONFLICT DO NOTHING ; .select() renvoie [] si c'était un doublon.
async function upsertCall(opts: {
  phone: string;
  occurredAt: string;
  clientEmail: string;
  callSid: string;
  userId: string | null;
  statut?: string;
  type?: string;
}): Promise<boolean> {
  const row: Record<string, unknown> = {
    call_sid: opts.callSid,
    phone: opts.phone,
    occurred_at: opts.occurredAt,
    client_email: opts.clientEmail,
    user_id: opts.userId,
    type: opts.type ?? 'Manqué',
  };
  if (opts.statut !== undefined) row.statut = opts.statut; // '' = décroché à qualifier

  const { data, error } = await supabaseAdmin()
    .from('calls')
    .upsert(row, { onConflict: 'call_sid', ignoreDuplicates: true })
    .select('id');
  if (error) {
    console.error('Postgres upsert failed:', error);
    throw new Error('Postgres upsert failed');
  }
  return Array.isArray(data) && data.length > 0;
}

async function sendBrevoSMS(phone: string, profile: ClientProfile): Promise<void> {
  const content = buildSmsContent(profile, phone);
  const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: {
      'api-key': Deno.env.get('BREVO_API_KEY')!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sender: FALLBACK_SMS_SENDER, recipient: phone, content, type: 'transactional' }),
  });
  if (!res.ok) {
    console.error('Brevo SMS failed:', await res.text());
    throw new Error('Brevo SMS failed');
  }
}

// Traite un appel manqué : dédups (phone+heure puis call_sid atomique) → SMS + Postgres.
async function handleMissedCall(
  fromPhone: string,
  _toNumber: string,
  callSid: string,
  profile: ClientProfile,
): Promise<void> {
  if (!isFrenchPhone(fromPhone)) {
    console.log('Non-French number, skipping SMS:', fromPhone);
    try {
      await upsertCall({ phone: fromPhone, occurredAt: new Date().toISOString(), clientEmail: profile.email, callSid, userId: profile.id, statut: 'Numéro non-FR' });
    } catch (e) { console.error('Spam log failed:', e); }
    return;
  }
  if (await isPhoneRecentlyProcessed(fromPhone, profile.email)) {
    console.log('Phone recently processed, skipping:', fromPhone);
    return;
  }
  const isNewCall = await upsertCall({ phone: fromPhone, occurredAt: new Date().toISOString(), clientEmail: profile.email, callSid, userId: profile.id });
  if (!isNewCall) {
    console.log('Deduped on call_sid:', callSid);
    return;
  }
  await sendBrevoSMS(fromPhone, profile);
  console.log('Missed call handled, SMS sent:', fromPhone);
}

// Quand on décroche un appel, on "résout" les appels MANQUÉS récents encore "À rappeler"
// du MÊME numéro (le prospect a rappelé et on a répondu → plus rien à rappeler).
// Ils passent en "Rappelé" (gardés dans l'historique, mais hors file d'attente).
const RESOLVE_MISSED_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
async function resolveRecentMissed(phone: string, clientEmail: string): Promise<void> {
  const since = new Date(Date.now() - RESOLVE_MISSED_WINDOW_MS).toISOString();
  const { error } = await supabaseAdmin()
    .from('calls')
    .update({ statut: 'Rappelé' })
    .eq('phone', phone)
    .eq('client_email', clientEmail)
    .eq('type', 'Manqué')
    .eq('statut', 'À rappeler')
    .gte('occurred_at', since);
  if (error) console.error('resolveRecentMissed failed:', error);
}

// Journalise un appel DÉCROCHÉ (conversation live). Pas de SMS, statut vide = "à qualifier".
async function handleAnsweredCall(
  fromPhone: string,
  callSid: string,
  profile: ClientProfile,
): Promise<void> {
  await upsertCall({ phone: fromPhone, occurredAt: new Date().toISOString(), clientEmail: profile.email, callSid, userId: profile.id, statut: '', type: 'Décroché' });
  // Le prospect a rappelé et on a décroché → ses appels manqués récents ne sont plus "à rappeler"
  await resolveRecentMissed(fromPhone, profile.email);
  console.log('Answered call logged + missed resolved:', fromPhone);
}

function xmlResponse(xml: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`, {
    headers: { 'Content-Type': 'application/xml', ...corsHeaders },
  });
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const url = new URL(req.url);
    const step = url.searchParams.get('step') ?? 'initial';
    const enc = encodeURIComponent;
    const base = PUBLIC_BASE;

    const formData = await req.formData();
    const bodyFrom = formData.get('From')?.toString() ?? '';
    const bodyTo = formData.get('To')?.toString() ?? '';
    const bodyCallSid = formData.get('CallSid')?.toString() ?? '';

    // ───────────────────────────────────────────────────────────────────────
    // STEP: dialresult — callback de fin de <Dial>.
    // "completed" = décrochage HUMAIN (timeout court < messagerie). Sinon = manqué → SMS.
    // ───────────────────────────────────────────────────────────────────────
    if (step === 'dialresult') {
      const caller = url.searchParams.get('caller') ?? '';
      const tn = url.searchParams.get('tn') ?? '';
      const cid = url.searchParams.get('cid') ?? bodyCallSid;
      const dialCallStatus = formData.get('DialCallStatus')?.toString() ?? '';
      const dialCallDuration = formData.get('DialCallDuration')?.toString() ?? '';
      console.log('Dial result:', { cid, dialCallStatus, dialCallDuration });

      // completed = l'artisan a décroché en live → aucun SMS, mais on journalise l'appel
      // (Type='Décroché') pour l'onglet "Appels décrochés" + le suivi du CA généré.
      if (dialCallStatus === 'completed') {
        console.log('Answered live (human), no SMS:', cid);
        const profile = await getClientProfile(tn);
        try {
          await handleAnsweredCall(caller, cid, profile);
        } catch (e) { console.error('handleAnsweredCall failed:', e); }
        return xmlResponse('<Response><Hangup/></Response>');
      }

      // no-answer / busy / failed / canceled → appel manqué → SMS (+ dédups dans handleMissedCall)
      console.log('Missed call (status=' + dialCallStatus + '), sending SMS:', cid);
      const profile = await getClientProfile(tn);
      try {
        await handleMissedCall(caller, tn, cid, profile);
      } catch (e) { console.error('handleMissedCall (dialresult) failed:', e); }
      return xmlResponse('<Response><Hangup/></Response>');
    }

    // ───────────────────────────────────────────────────────────────────────
    // STEP: initial — appel entrant sur le numéro Telnyx du pro.
    // ───────────────────────────────────────────────────────────────────────
    console.log('TeXML initial request:', { from: bodyFrom, to: bodyTo, callSid: bodyCallSid });
    const profile = await getClientProfile(bodyTo);

    // Pas de forward configuré → mode "Always SMS" direct.
    if (!profile.forwardToPhone) {
      console.warn('No forward_to_phone for', bodyTo, '— direct missed call handling');
      try {
        await handleMissedCall(bodyFrom, bodyTo, bodyCallSid, profile);
      } catch (e) { console.error('Direct missed call handling failed:', e); }
      return xmlResponse('<Response><Hangup/></Response>');
    }

    // Modèle numéro dédié : on sonne le mobile de l'artisan. Timeout COURT (< messagerie).
    // ⚠️ PAS de answerOnBridge : on décroche l'appel entrant immédiatement (sinon 480 → boucle).
    const dialAction = `${base}?step=dialresult&caller=${enc(bodyFrom)}&tn=${enc(bodyTo)}&cid=${enc(bodyCallSid)}`;
    const xml = `<Response>
  <Dial timeout="${DIAL_TIMEOUT_SEC}" action="${esc(dialAction)}" method="POST" callerId="${esc(bodyTo)}">${esc(profile.forwardToPhone)}</Dial>
</Response>`;
    return xmlResponse(xml);
  } catch (err) {
    console.error('telnyx-texml error:', err);
    return xmlResponse('<Response><Hangup/></Response>');
  }
});
