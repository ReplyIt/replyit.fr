import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const AT_BASE = Deno.env.get('AIRTABLE_BASE') ?? 'apptXlbxzPEn7zYFD';
const AT_TABLE = Deno.env.get('AIRTABLE_TABLE') ?? 'tblFhzjEIVLBcedY1';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function getUser(req: Request) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  return user;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const token = Deno.env.get('AIRTABLE_TOKEN');
  if (!token) {
    return json({ error: 'AIRTABLE_TOKEN not configured' }, 500);
  }

  const user = await getUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const clientName = user.user_metadata?.client_name as string | undefined;
  const atHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  if (req.method === 'GET') {
    let url =
      `https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}?sort%5B0%5D%5Bfield%5D=Heure%20d%27appel&sort%5B0%5D%5Bdirection%5D=desc`;
    if (clientName) {
      url += `&filterByFormula=${encodeURIComponent(`{Nom client}="${clientName}"`)}`;
    }

    const res = await fetch(url, { headers: atHeaders });
    const data = await res.json();
    if (!res.ok) return json(data, res.status);
    return json(data);
  }

  if (req.method === 'PATCH') {
    const { id, statut } = await req.json();
    if (!id || !statut) return json({ error: 'Missing id or statut' }, 400);

    const res = await fetch(
      `https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}/${id}`,
      {
        method: 'PATCH',
        headers: atHeaders,
        body: JSON.stringify({ fields: { Statut: statut } }),
      },
    );
    const data = await res.json();
    if (!res.ok) return json(data, res.status);
    return json(data);
  }

  return json({ error: 'Method not allowed' }, 405);
});
