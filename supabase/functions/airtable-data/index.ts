// Données du dashboard — lit/écrit la table Postgres public.calls.
// (Migré depuis Airtable 2026-06-02.)
//
// La réponse GET est mappée au MÊME format que l'ancienne API Airtable
// ({ records: [{ id, fields: {...} }] }) → le dashboard reste inchangé.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
};

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

async function isActive(userId: string): Promise<boolean> {
  const { data } = await admin().from('profiles').select('status').eq('id', userId).single();
  return data?.status === 'active';
}

// Mappe une ligne Postgres → format "record Airtable" attendu par le dashboard.
function toRecord(r: Record<string, unknown>) {
  return {
    id: r.id,
    fields: {
      'Name': r.phone,
      'Numéro client': r.phone,
      "Heure d'appel": r.occurred_at,
      'Message prospect': r.message ?? '',
      'Statut': r.statut ?? '',
      'Montant': r.montant,
      'Type': r.type ?? 'Manqué',
      'Rappelé le': r.rappele_le,
      'Email client': r.client_email,
      'Call ID': r.call_sid,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const user = await getUser(req);
  if (!user) return json({ error: 'Unauthorized' }, 401);

  if (!(await isActive(user.id))) return json({ error: 'Subscription required' }, 403);

  const sb = admin();

  if (req.method === 'GET') {
    const { data, error } = await sb
      .from('calls')
      .select('id, call_sid, phone, occurred_at, message, statut, montant, type, rappele_le, client_email')
      .eq('user_id', user.id)
      .order('occurred_at', { ascending: false });
    if (error) return json({ error: error.message }, 500);
    return json({ records: (data ?? []).map(toRecord) });
  }

  if (req.method === 'PATCH') {
    const { id, statut, montant, rappeleLe } = await req.json();
    if (!id) return json({ error: 'Missing id' }, 400);

    const update: Record<string, unknown> = {};
    if (typeof statut === 'string' && statut.length > 0) {
      update.statut = statut.normalize('NFC');
    }
    // Horodatage du 1er rappel (KPI "délai moyen de rappel"). Date ISO valide uniquement.
    if (typeof rappeleLe === 'string' && rappeleLe.length > 0) {
      const d = new Date(rappeleLe);
      if (!isNaN(d.getTime())) update.rappele_le = d.toISOString();
    }
    if (montant !== undefined) {
      if (montant === null || montant === '') {
        update.montant = null;
      } else {
        const n = Number(montant);
        if (!Number.isFinite(n) || n < 0) return json({ error: 'Invalid montant' }, 400);
        update.montant = n;
      }
    }
    if (Object.keys(update).length === 0) return json({ error: 'Nothing to update' }, 400);

    // Sécurité : on ne met à jour QUE les lignes appartenant à l'utilisateur authentifié.
    const { data, error } = await sb
      .from('calls')
      .update(update)
      .eq('id', id)
      .eq('user_id', user.id)
      .select('id')
      .maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!data) return json({ error: 'Not found' }, 404);
    return json({ success: true, id: data.id });
  }

  return json({ error: 'Method not allowed' }, 405);
});
