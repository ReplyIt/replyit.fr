// Telnyx Voice webhook → reject call + dedup + Airtable + Brevo SMS
// Remplace le scénario 1 de Make (ReplyIt w/Telnyx). Multi-tenant.
//
// Comportement :
//   - Filtre les events qui ne sont pas `call.initiated` (call.hangup, etc.)
//   - Lookup du client via `payload.to` (numéro Telnyx appelé) dans la table profiles
//   - Reject l'appel via Telnyx API (cause: CALL_REJECTED → carrier ne retry pas)
//   - Dédup via Airtable : si un appel du même numéro existe dans la dernière heure
//     pour ce client, on skip Airtable + SMS
//   - Sinon : crée la ligne Airtable + envoie le SMS via Brevo (en parallèle)
//
// Multi-tenant via colonne `profiles.telnyx_number`. Fallback CLIENT_EMAIL si pas trouvé (test).

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

interface ClientProfile {
  email: string;
  businessName: string | null;
  smsSender: string;
  smsTemplate: string | null;
}

async function getClientProfile(telnyxNumber: string | undefined): Promise<ClientProfile> {
  const fallback: ClientProfile = {
    email: FALLBACK_CLIENT_EMAIL,
    businessName: null,
    smsSender: FALLBACK_SMS_SENDER,
    smsTemplate: null,
  };
  if (!telnyxNumber) return fallback;
  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SB_SERVICE_ROLE_KEY')!,
    );
    const { data } = await supabase
      .from('profiles')
      .select('email, business_name, sms_sender, sms_template')
      .eq('telnyx_number', telnyxNumber)
      .eq('status', 'active')
      .maybeSingle();
    if (!data) return fallback;
    return {
      email: data.email ?? FALLBACK_CLIENT_EMAIL,
      businessName: data.business_name,
      smsSender: data.sms_sender || FALLBACK_SMS_SENDER,
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

  // Template custom du client (texte littéral, pas de substitution complexe)
  if (profile.smsTemplate && profile.smsTemplate.trim().length > 0) {
    return `${profile.smsTemplate.trim()} ${tallyUrl}`;
  }

  // Template par défaut
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

async function isAlreadyProcessed(phone: string, clientEmail: string): Promise<boolean> {
  // (signature inchangée)
  // Cherche un enregistrement Airtable du même numéro pour ce client dans la dernière heure
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const formula = `AND({Numéro client}="${phone}", {Email client}="${clientEmail}", IS_AFTER({Heure d'appel}, "${oneHourAgo}"))`;
  const url = `https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${Deno.env.get('AIRTABLE_TOKEN')}` },
  });
  if (!res.ok) {
    console.error('Airtable dedup check failed:', await res.text());
    return false; // si échec, on continue plutôt que de bloquer
  }
  const data = await res.json();
  return Array.isArray(data.records) && data.records.length > 0;
}

async function rejectTelnyxCall(callControlId: string): Promise<void> {
  const res = await fetch(
    `https://api.telnyx.com/v2/calls/${callControlId}/actions/reject`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('TELNYX_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cause: 'CALL_REJECTED' }),
    },
  );
  if (!res.ok) {
    console.error('Telnyx reject failed:', await res.text());
  }
}

async function createAirtableRecord(phone: string, occurredAt: string, clientEmail: string): Promise<void> {
  const res = await fetch(`https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('AIRTABLE_TOKEN')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      records: [{
        fields: {
          'Name': phone,
          'Numéro client': phone,
          "Heure d'appel": occurredAt,
          'Statut': 'À rappeler',
          'Email client': clientEmail,
        },
      }],
      typecast: true,
    }),
  });
  if (!res.ok) {
    console.error('Airtable create failed:', await res.text());
    throw new Error('Airtable create failed');
  }
}

async function sendBrevoSMS(phone: string, profile: ClientProfile): Promise<void> {
  const content = buildSmsContent(profile, phone);

  // ⚠️ En France, les senders alphanumériques custom doivent être pré-enregistrés
  // auprès de l'AFNUM. Pour scale, on utilise UN sender unique pré-validé (FALLBACK_SMS_SENDER)
  // pour tous les clients. Le branding du client passe via le body (business_name).
  // Le champ profile.smsSender est gardé en DB pour usage futur (upgrade plan / autre provider).
  const sender = FALLBACK_SMS_SENDER;

  const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
    method: 'POST',
    headers: {
      'api-key': Deno.env.get('BREVO_API_KEY')!,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender,
      recipient: phone,
      content,
      type: 'transactional',
    }),
  });
  if (!res.ok) {
    console.error('Brevo SMS failed:', await res.text());
    throw new Error('Brevo SMS failed');
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const payload = await req.json();
    const eventType = payload?.data?.event_type;

    // On ne traite que les call.initiated. Les call.hangup et autres sont ignorés.
    if (eventType !== 'call.initiated') {
      return json({ skipped: eventType });
    }

    const callControlId = payload.data.payload?.call_control_id;
    const phone = payload.data.payload?.from;
    const toNumber = payload.data.payload?.to;
    const occurredAt = payload.data.occurred_at;

    if (!callControlId || !phone) {
      return json({ error: 'Missing required fields in payload' }, 400);
    }

    // Reject de l'appel : on lance tout de suite pour libérer le canal Telnyx
    const rejectPromise = rejectTelnyxCall(callControlId);

    // Lookup du profil client par son numéro Telnyx (multi-tenant + perso SMS)
    const profile = await getClientProfile(toNumber);

    // Dédup
    if (await isAlreadyProcessed(phone, profile.email)) {
      await rejectPromise;
      return json({ deduped: true, phone, clientEmail: profile.email });
    }

    // Airtable + Brevo en parallèle (avec reject déjà en cours)
    await Promise.all([
      rejectPromise,
      createAirtableRecord(phone, occurredAt, profile.email),
      sendBrevoSMS(phone, profile),
    ]);

    return json({ success: true, phone, clientEmail: profile.email, sender: profile.smsSender });
  } catch (err) {
    console.error('telnyx-webhook error:', err);
    // On retourne 200 quand même pour éviter que Telnyx retry inutilement
    return json({ error: (err as Error).message }, 200);
  }
});
