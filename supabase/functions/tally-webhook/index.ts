// Tally form submission webhook → met à jour le `message` du prospect (table Postgres calls).
// (Migré depuis Airtable 2026-06-02.)
//
// Comportement :
//   - Extrait le `phone` (champ caché) et le `message` (texte saisi)
//   - Cherche la ligne `calls` la plus récente avec ce numéro
//   - Met à jour son champ `message`

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TALLY_PHONE_KEY = Deno.env.get('TALLY_PHONE_KEY') ??
  'question_1EY4dW_1166bd68-0396-4ae0-8a22-51b34b01043f';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function admin() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SB_SERVICE_ROLE_KEY')!,
  );
}

interface TallyField { key: string; label?: string; type?: string; value?: string; }

function extractPhone(fields: TallyField[]): string | null {
  const byKey = fields.find((f) => f.key === TALLY_PHONE_KEY);
  if (byKey?.value) return decodeURIComponent(byKey.value);
  const byLabel = fields.find((f) => f.label?.toLowerCase() === 'phone');
  if (byLabel?.value) return decodeURIComponent(byLabel.value);
  return null;
}

function extractMessage(fields: TallyField[]): string | null {
  const textField = fields.find((f) =>
    (f.type === 'TEXTAREA' || f.type === 'INPUT_TEXT') &&
    f.key !== TALLY_PHONE_KEY &&
    f.label?.toLowerCase() !== 'phone' &&
    typeof f.value === 'string' &&
    f.value.trim().length > 0
  );
  return textField?.value ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const payload = await req.json();
    const fields: TallyField[] = payload?.data?.fields ?? [];

    const phone = extractPhone(fields);
    const message = extractMessage(fields);

    if (!phone) return json({ error: 'Phone not found in payload' }, 400);
    if (!message) return json({ error: 'Message not found in payload' }, 400);

    const sb = admin();

    // 1) Ligne la plus récente avec ce numéro
    const { data: rows, error: searchErr } = await sb
      .from('calls')
      .select('id')
      .eq('phone', phone)
      .order('occurred_at', { ascending: false })
      .limit(1);
    if (searchErr) {
      console.error('calls search failed:', searchErr);
      return json({ error: 'search failed' }, 500);
    }
    const record = rows?.[0];
    if (!record) return json({ error: 'No matching record', phone }, 404);

    // 2) Maj du message
    const { error: updErr } = await sb
      .from('calls')
      .update({ message })
      .eq('id', record.id);
    if (updErr) {
      console.error('calls update failed:', updErr);
      return json({ error: 'update failed' }, 500);
    }

    return json({ success: true, id: record.id, phone });
  } catch (err) {
    console.error('tally-webhook error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
