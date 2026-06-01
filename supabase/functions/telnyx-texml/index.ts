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
// Pourquoi le timeout court : si on laissait sonner trop longtemps, la messagerie du mobile
// de l'artisan décrocherait et ferait un faux "answered" → pas de SMS. En coupant avant,
// un statut "completed" signifie de façon fiable un décrochage HUMAIN.
// (Alternative possible si besoin : AMD/answering machine detection — non retenu car moins
//  déterministe et non validé.)
//
// Routing par query param `step` :
//   (aucun)         → appel entrant initial → <Dial timeout> vers le mobile artisan
//   step=dialresult → callback fin de <Dial> : completed = répondu live (no SMS), sinon SMS

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const AT_BASE = Deno.env.get('AIRTABLE_BASE') ?? 'apptXlbxzPEn7zYFD';
const AT_TABLE = Deno.env.get('AIRTABLE_TABLE') ?? 'tblFhzjEIVLBcedY1';
const FALLBACK_CLIENT_EMAIL = Deno.env.get('CLIENT_EMAIL') ?? 'template@yopmail.com';
const FALLBACK_SMS_SENDER = Deno.env.get('BREVO_SENDER') ?? 'ReplyIt';
const TALLY_FORM_URL = Deno.env.get('TALLY_FORM_URL') ?? 'https://tally.so/r/VLDjpa';

// ⚠️ URL PUBLIQUE de cette fonction, construite depuis SUPABASE_URL (env fiable).
// On NE PEUT PAS utiliser req.url : dans Supabase Edge Functions il contient l'URL
// INTERNE (host non public), ce qui rend les callbacks Telnyx (whisper/action)
// injoignables → "application error has occurred. Goodbye".
const PUBLIC_BASE = `${Deno.env.get('SUPABASE_URL')}/functions/v1/telnyx-texml`;

// Durée de sonnerie du mobile de l'artisan avant no-answer → SMS.
// ⚠️ DOIT rester < timer messagerie du mobile de l'artisan, pour que Telnyx coupe la jambe
// AVANT que la messagerie mobile ne réponde (sinon faux "answered" → pas de SMS).
const DIAL_TIMEOUT_SEC = 18;

interface ClientProfile {
  email: string;
  businessName: string | null;
  smsTemplate: string | null;
  forwardToPhone: string | null;
}

async function getClientProfile(telnyxNumber: string | undefined): Promise<ClientProfile> {
  const fallback: ClientProfile = {
    email: FALLBACK_CLIENT_EMAIL,
    businessName: null,
    smsTemplate: null,
    forwardToPhone: null,
  };
  if (!telnyxNumber) return fallback;
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SB_SERVICE_ROLE_KEY')!,
    );
    const { data } = await supabase
      .from('profiles')
      .select('email, business_name, sms_template, forward_to_phone')
      .eq('telnyx_number', telnyxNumber)
      .eq('status', 'active')
      .maybeSingle();
    if (!data) return fallback;
    return {
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

async function isPhoneRecentlyProcessed(phone: string, clientEmail: string): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const formula = `AND({Numéro client}="${phone}", {Email client}="${clientEmail}", IS_AFTER({Heure d'appel}, "${oneHourAgo}"))`;
  const url = `https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${Deno.env.get('AIRTABLE_TOKEN')}` },
  });
  if (!res.ok) {
    console.error('Airtable phone dedup check failed:', await res.text());
    return false;
  }
  const data = await res.json();
  return Array.isArray(data.records) && data.records.length > 0;
}

// Upsert atomique par CallSid (catch les retries Telnyx). Retourne true si nouvelle ligne.
async function upsertAirtableRecord(
  phone: string,
  occurredAt: string,
  clientEmail: string,
  callSid: string,
  statut: string = 'À rappeler',
): Promise<boolean> {
  const res = await fetch(`https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${Deno.env.get('AIRTABLE_TOKEN')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      performUpsert: { fieldsToMergeOn: ['Call ID'] },
      records: [{
        fields: {
          'Name': phone,
          'Numéro client': phone,
          "Heure d'appel": occurredAt,
          'Statut': statut,
          'Email client': clientEmail,
          'Call ID': callSid,
        },
      }],
      typecast: true,
    }),
  });
  if (!res.ok) {
    console.error('Airtable upsert failed:', await res.text());
    throw new Error('Airtable upsert failed');
  }
  const data = await res.json();
  return Array.isArray(data.createdRecords) && data.createdRecords.length > 0;
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

// Traite un appel manqué : dédups (phone+heure puis CallSid atomique) → SMS + Airtable.
async function handleMissedCall(
  fromPhone: string,
  toNumber: string,
  callSid: string,
  profile: ClientProfile,
): Promise<void> {
  if (!isFrenchPhone(fromPhone)) {
    console.log('Non-French number, skipping SMS:', fromPhone);
    try {
      await upsertAirtableRecord(fromPhone, new Date().toISOString(), profile.email, callSid, 'Numéro non-FR');
    } catch (e) { console.error('Airtable spam log failed:', e); }
    return;
  }
  if (await isPhoneRecentlyProcessed(fromPhone, profile.email)) {
    console.log('Phone recently processed, skipping:', fromPhone);
    return;
  }
  const isNewCall = await upsertAirtableRecord(fromPhone, new Date().toISOString(), profile.email, callSid);
  if (!isNewCall) {
    console.log('Deduped on Call ID:', callSid);
    return;
  }
  await sendBrevoSMS(fromPhone, profile);
  console.log('Missed call handled, SMS sent:', fromPhone);
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
    // Le <Dial timeout> est volontairement COURT (< timer messagerie du mobile
    // de l'artisan). Donc un "completed" = décrochage HUMAIN (la messagerie n'a
    // pas eu le temps de répondre). Tout le reste = appel manqué → SMS.
    // ───────────────────────────────────────────────────────────────────────
    if (step === 'dialresult') {
      const caller = url.searchParams.get('caller') ?? '';
      const tn = url.searchParams.get('tn') ?? '';
      const cid = url.searchParams.get('cid') ?? bodyCallSid;
      const dialCallStatus = formData.get('DialCallStatus')?.toString() ?? '';
      const dialCallDuration = formData.get('DialCallDuration')?.toString() ?? '';
      console.log('Dial result:', { cid, dialCallStatus, dialCallDuration });

      // completed = l'artisan a décroché en live → aucun SMS, pas de ligne Airtable
      // (le dashboard ne liste QUE les appels manqués à rappeler).
      if (dialCallStatus === 'completed') {
        console.log('Answered live (human), no SMS:', cid);
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

    // Modèle numéro dédié : on sonne le mobile de l'artisan. Timeout COURT (DIAL_TIMEOUT_SEC,
    // < timer messagerie mobile) pour couper la jambe AVANT que sa messagerie ne réponde
    // (sinon faux "answered" → pas de SMS). callerId = numéro Telnyx (qu'on possède).
    //
    // ⚠️ PAS de answerOnBridge : on décroche l'appel entrant immédiatement. Sinon, sur dial
    // no-answer, on raccrocherait un appel jamais décroché → Telnyx renvoie "480 Temporarily
    // Unavailable" → l'opérateur de l'appelant RE-TENTE en boucle (bug constaté). En décrochant
    // d'abord, le hangup = BYE normal → aucun retry → pas de boucle. L'appelant entend la
    // sonnerie (ringback généré par Telnyx) pendant le dial.
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
