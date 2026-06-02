// Telnyx Voice webhook (Call Control) — LEGACY / RÉSERVE (non utilisé en prod).
// La prod utilise telnyx-texml (modèle numéro dédié). Gardé en réserve.
// Stockage migré Airtable → Postgres (public.calls) le 2026-06-02.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const FALLBACK_CLIENT_EMAIL = Deno.env.get('CLIENT_EMAIL') ?? 'template@yopmail.com';
const FALLBACK_SMS_SENDER = Deno.env.get('BREVO_SENDER') ?? 'ReplyIt';
const TALLY_FORM_URL = Deno.env.get('TALLY_FORM_URL') ?? 'https://tally.so/r/VLDjpa';

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
}

async function getClientProfile(telnyxNumber: string | undefined): Promise<ClientProfile> {
  const fallback: ClientProfile = { id: null, email: FALLBACK_CLIENT_EMAIL, businessName: null, smsTemplate: null };
  if (!telnyxNumber) return fallback;
  try {
    const { data } = await supabaseAdmin()
      .from('profiles')
      .select('id, email, business_name, sms_template')
      .eq('telnyx_number', telnyxNumber)
      .eq('status', 'active')
      .maybeSingle();
    if (!data) return fallback;
    return {
      id: data.id ?? null,
      email: data.email ?? FALLBACK_CLIENT_EMAIL,
      businessName: data.business_name,
      smsTemplate: data.sms_template,
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function isPhoneRecentlyProcessed(phone: string, clientEmail: string): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin()
    .from('calls')
    .select('id')
    .eq('phone', phone)
    .eq('client_email', clientEmail)
    .gt('occurred_at', oneHourAgo)
    .limit(1);
  if (error) { console.error('Postgres dedup check failed:', error); return false; }
  return Array.isArray(data) && data.length > 0;
}

// Upsert atomique par call_sid. Retourne true si NOUVELLE ligne (sinon retry Telnyx → pas de SMS).
async function upsertCall(opts: {
  phone: string; occurredAt: string; clientEmail: string; callSid: string; userId: string | null; statut?: string;
}): Promise<boolean> {
  const row: Record<string, unknown> = {
    call_sid: opts.callSid, phone: opts.phone, occurred_at: opts.occurredAt,
    client_email: opts.clientEmail, user_id: opts.userId, type: 'Manqué',
  };
  if (opts.statut !== undefined) row.statut = opts.statut;
  const { data, error } = await supabaseAdmin()
    .from('calls')
    .upsert(row, { onConflict: 'call_sid', ignoreDuplicates: true })
    .select('id');
  if (error) { console.error('Postgres upsert failed:', error); throw new Error('Postgres upsert failed'); }
  return Array.isArray(data) && data.length > 0;
}

async function answerThenHangup(callControlId: string): Promise<void> {
  const headers = {
    Authorization: `Bearer ${Deno.env.get('TELNYX_API_KEY')}`,
    'Content-Type': 'application/json',
  };
  const answerRes = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`, { method: 'POST', headers });
  if (!answerRes.ok) { console.error('Telnyx answer failed:', await answerRes.text()); return; }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const hangupRes = await fetch(`https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`, { method: 'POST', headers });
  if (!hangupRes.ok) { console.error('Telnyx hangup failed:', await hangupRes.text()); }
}

function isFrenchPhone(phone: string): boolean {
  if (!phone) return false;
  const cleaned = phone.replace(/[\s\-\.\(\)]/g, '');
  if (/^\+33[1-9]\d{8}$/.test(cleaned)) return true;
  if (/^0[1-9]\d{8}$/.test(cleaned)) return true;
  return false;
}

async function sendBrevoSMS(phone: string, profile: ClientProfile): Promise<void> {
  const content = buildSmsContent(profile, phone);
  const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: { 'api-key': Deno.env.get('BREVO_API_KEY')!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: FALLBACK_SMS_SENDER, recipient: phone, content, type: 'transactional' }),
  });
  if (!res.ok) { console.error('Brevo SMS failed:', await res.text()); throw new Error('Brevo SMS failed'); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const payload = await req.json();
    const eventType = payload?.data?.event_type;
    if (eventType !== 'call.initiated') return json({ skipped: eventType });

    const callControlId = payload.data.payload?.call_control_id;
    const phone = payload.data.payload?.from;
    const toNumber = payload.data.payload?.to;
    const occurredAt = payload.data.occurred_at ?? new Date().toISOString();

    if (!callControlId || !phone) return json({ error: 'Missing required fields in payload' }, 400);

    const callTerminationPromise = answerThenHangup(callControlId);
    const profile = await getClientProfile(toNumber);

    if (!isFrenchPhone(phone)) {
      await callTerminationPromise;
      console.log('Non-French number rejected (SMS skipped):', phone);
      try {
        await upsertCall({ phone, occurredAt, clientEmail: profile.email, callSid: callControlId, userId: profile.id, statut: 'Numéro non-FR' });
      } catch (e) { console.error('Spam log failed:', e); }
      return json({ skipped: 'non_french_number', phone });
    }

    if (await isPhoneRecentlyProcessed(phone, profile.email)) {
      await callTerminationPromise;
      console.log('Phone deduped (recent activity):', phone);
      return json({ deduped: 'phone_recent', phone });
    }

    const isNewCall = await upsertCall({ phone, occurredAt, clientEmail: profile.email, callSid: callControlId, userId: profile.id });
    if (!isNewCall) {
      await callTerminationPromise;
      console.log('Deduped (Telnyx retry):', callControlId);
      return json({ deduped: 'telnyx_retry', callControlId });
    }

    await Promise.all([callTerminationPromise, sendBrevoSMS(phone, profile)]);
    return json({ success: true, phone, clientEmail: profile.email });
  } catch (err) {
    console.error('telnyx-webhook error:', err);
    return json({ error: (err as Error).message }, 200);
  }
});
