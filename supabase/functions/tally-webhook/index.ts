// Tally form submission webhook → update Airtable "Message prospect"
// Remplace le scénario 2 de Make (Tally Réponse Prospect).
//
// Comportement :
//   - Extrait le `phone` (champ caché) et le `message` (texte saisi par le prospect)
//   - Cherche dans Airtable la ligne la plus récente avec ce numéro
//   - Met à jour le champ "Message prospect" avec le contenu du formulaire
//
// Format payload Tally :
//   {
//     "data": {
//       "fields": [
//         { "key": "...", "label": "...", "type": "INPUT_TEXT" | "TEXTAREA", "value": "..." }
//       ]
//     }
//   }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const AT_BASE = Deno.env.get('AIRTABLE_BASE') ?? 'apptXlbxzPEn7zYFD';
const AT_TABLE = Deno.env.get('AIRTABLE_TABLE') ?? 'tblFhzjEIVLBcedY1';

// Clé du champ caché "phone" du formulaire Tally
const TALLY_PHONE_KEY = Deno.env.get('TALLY_PHONE_KEY') ??
  'question_1EY4dW_1166bd68-0396-4ae0-8a22-51b34b01043f';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface TallyField {
  key: string;
  label?: string;
  type?: string;
  value?: string;
}

function extractPhone(fields: TallyField[]): string | null {
  // 1) D'abord on cherche par clé exacte du champ caché
  const byKey = fields.find((f) => f.key === TALLY_PHONE_KEY);
  if (byKey?.value) return decodeURIComponent(byKey.value);

  // 2) Fallback : par label
  const byLabel = fields.find((f) => f.label?.toLowerCase() === 'phone');
  if (byLabel?.value) return decodeURIComponent(byLabel.value);

  return null;
}

function extractMessage(fields: TallyField[]): string | null {
  // On prend le premier champ TEXTAREA ou INPUT_TEXT qui n'est pas le phone
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

    const token = Deno.env.get('AIRTABLE_TOKEN')!;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    // 1) Cherche la ligne Airtable la plus récente avec ce numéro
    const formula = encodeURIComponent(`{Numéro client}="${phone}"`);
    const searchUrl =
      `https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}` +
      `?filterByFormula=${formula}` +
      `&sort%5B0%5D%5Bfield%5D=Heure%20d%27appel` +
      `&sort%5B0%5D%5Bdirection%5D=desc` +
      `&maxRecords=1`;

    const searchRes = await fetch(searchUrl, { headers });
    if (!searchRes.ok) {
      const err = await searchRes.text();
      console.error('Airtable search failed:', err);
      return json({ error: 'Airtable search failed' }, 500);
    }
    const searchData = await searchRes.json();
    const record = searchData.records?.[0];

    if (!record) return json({ error: 'No matching record', phone }, 404);

    // 2) Update "Message prospect"
    const updateRes = await fetch(
      `https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}/${record.id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields: { 'Message prospect': message } }),
      },
    );
    if (!updateRes.ok) {
      const err = await updateRes.text();
      console.error('Airtable update failed:', err);
      return json({ error: 'Airtable update failed' }, 500);
    }

    return json({ success: true, recordId: record.id, phone });
  } catch (err) {
    console.error('tally-webhook error:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
