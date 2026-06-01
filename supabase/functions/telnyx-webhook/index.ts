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

  // Template custom du client (avec placeholder {business_name} substitué dynamiquement)
  if (profile.smsTemplate && profile.smsTemplate.trim().length > 0) {
    const body = profile.smsTemplate.trim().replace(/\{business_name\}/g, brand);
    return `${body} ${tallyUrl}`;
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

// Dédup "même prospect dans la dernière heure" — pour éviter de spammer un prospect
// qui rappelle plusieurs fois, et garder le dashboard propre (1 ligne par appelant/heure).
async function isPhoneRecentlyProcessed(phone: string, clientEmail: string): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const formula = `AND({Numéro client}="${phone}", {Email client}="${clientEmail}", IS_AFTER({Heure d'appel}, "${oneHourAgo}"))`;
  const url = `https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${Deno.env.get('AIRTABLE_TOKEN')}` },
  });
  if (!res.ok) {
    console.error('Airtable phone dedup check failed:', await res.text());
    return false; // en cas d'erreur, on continue plutôt que de bloquer
  }
  const data = await res.json();
  return Array.isArray(data.records) && data.records.length > 0;
}

// Dédup atomique côté Airtable via performUpsert sur le champ "Call ID".
// Si une ligne avec ce call_control_id existe déjà → Airtable l'update au lieu d'en créer
// une nouvelle. Retourne `true` si une ligne a vraiment été créée, `false` si c'est un
// retry Telnyx (= ne pas renvoyer de SMS).
async function upsertAirtableRecord(
  phone: string,
  occurredAt: string,
  clientEmail: string,
  callControlId: string,
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
          'Call ID': callControlId,
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
  // `createdRecords` = IDs des lignes nouvellement créées. Vide → c'est un update.
  return Array.isArray(data.createdRecords) && data.createdRecords.length > 0;
}

// 2026-05-30 : passage de `reject` à `answer + hangup`.
// Hypothèse : un reject instantané (CALL_REJECTED) déclenche un fallback vers la
// messagerie carrier côté opérateur du client (constaté chez RED by SFR), ce qui
// empêche les renvois conditionnels de fonctionner. En répondant à l'appel puis
// en raccrochant proprement, le réseau voit l'appel comme "abouti normalement"
// → pas de fallback messagerie, le renvoi conditionnel marche.
// Coût marginal : ~0.0001€/appel (1-2 sec d'inbound facturé par Telnyx).
async function answerThenHangup(callControlId: string): Promise<void> {
  const headers = {
    Authorization: `Bearer ${Deno.env.get('TELNYX_API_KEY')}`,
    'Content-Type': 'application/json',
  };

  // 1. Answer : on accepte l'appel pour que le réseau client le voie comme abouti
  const answerRes = await fetch(
    `https://api.telnyx.com/v2/calls/${callControlId}/actions/answer`,
    { method: 'POST', headers },
  );
  if (!answerRes.ok) {
    console.error('Telnyx answer failed:', await answerRes.text());
    return;
  }

  // 2. Petite pause pour que l'answer soit bien propagé côté réseau
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // 3. Hangup propre (cause par défaut = NORMAL_CLEARING)
  const hangupRes = await fetch(
    `https://api.telnyx.com/v2/calls/${callControlId}/actions/hangup`,
    { method: 'POST', headers },
  );
  if (!hangupRes.ok) {
    console.error('Telnyx hangup failed:', await hangupRes.text());
  }
}

// Vérifie qu'un numéro est un mobile/fixe français valide (format E.164 ou local).
// On évite d'envoyer des SMS à l'international (coûteux + souvent spam).
function isFrenchPhone(phone: string): boolean {
  if (!phone) return false;
  const cleaned = phone.replace(/[\s\-\.\(\)]/g, '');
  // Format international FR : +33[1-9]XXXXXXXX
  if (/^\+33[1-9]\d{8}$/.test(cleaned)) return true;
  // Format national : 0[1-9]XXXXXXXX
  if (/^0[1-9]\d{8}$/.test(cleaned)) return true;
  return false;
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

    // Termination de l'appel : answer + hangup (au lieu de reject) pour ne pas
    // déclencher le fallback messagerie côté carrier client. Cf. commentaire fonction.
    const callTerminationPromise = answerThenHangup(callControlId);

    // Lookup du profil client par son numéro Telnyx (multi-tenant + perso SMS)
    const profile = await getClientProfile(toNumber);

    // 🛡️ Anti-spam : on n'envoie de SMS qu'aux numéros FR (+33 ou 0X).
    if (!isFrenchPhone(phone)) {
      await callTerminationPromise;
      console.log('Non-French number rejected (SMS skipped):', phone);
      try {
        await upsertAirtableRecord(phone, occurredAt, profile.email, callControlId, 'Numéro non-FR');
      } catch (e) { console.error('Airtable spam log failed:', e); }
      return json({ skipped: 'non_french_number', phone });
    }
    console.log('Incoming call from:', phone);

    // 1. Dédup "même prospect dans la dernière heure" : si le même numéro a déjà appelé
    //    ce client dans l'heure, on bail out total (pas de ligne, pas de SMS).
    if (await isPhoneRecentlyProcessed(phone, profile.email)) {
      await callTerminationPromise;
      console.log('Phone deduped (recent activity):', phone);
      return json({ deduped: 'phone_recent', phone });
    }

    // 2. Upsert Airtable atomique par Call ID (catch les retries Telnyx du même appel).
    //    Si Telnyx retry → la ligne existe déjà → isNewCall=false → pas de SMS.
    const isNewCall = await upsertAirtableRecord(phone, occurredAt, profile.email, callControlId);
    if (!isNewCall) {
      await callTerminationPromise;
      console.log('Deduped (Telnyx retry):', callControlId);
      return json({ deduped: 'telnyx_retry', callControlId });
    }

    // 3. Nouveau prospect (ou rappel après 1h) : SMS + finaliser termination en parallèle
    await Promise.all([
      callTerminationPromise,
      sendBrevoSMS(phone, profile),
    ]);

    return json({ success: true, phone, clientEmail: profile.email, sender: profile.smsSender });
  } catch (err) {
    console.error('telnyx-webhook error:', err);
    // On retourne 200 quand même pour éviter que Telnyx retry inutilement
    return json({ error: (err as Error).message }, 200);
  }
});
