// Mise à jour sécurisée d'un profil client.
//
// - Vérifie le JWT Supabase du caller
// - N'accepte que les champs autorisés (business_name, sms_template, forward_to_phone)
// - Ne permet PAS de modifier status, plan, stripe_*, telnyx_number, email, id
// - Update profiles WHERE id = auth.uid()

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function getAuthenticatedUser(req: Request) {
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
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return json({ error: 'Unauthorized' }, 401);

    const body = await req.json();

    // Whitelist stricte des champs modifiables
    const update: Record<string, string | null> = {};

    if ('business_name' in body) {
      const v = (body.business_name ?? '').toString().trim();
      if (v.length > 60) return json({ error: 'business_name max 60 chars' }, 400);
      update.business_name = v.length > 0 ? v : null;
    }

    if ('sms_template' in body) {
      const v = (body.sms_template ?? '').toString().trim();
      if (v.length > 140) return json({ error: 'sms_template max 140 chars' }, 400);
      update.sms_template = v.length > 0 ? v : null;
    }

    // Mobile où les appels sont renvoyés. Essentiel au service → on exige un numéro FR
    // valide (pas de valeur vide autorisée). Normalisé en +33.
    if ('forward_to_phone' in body) {
      const cleaned = (body.forward_to_phone ?? '').toString().replace(/[\s.\-()]/g, '');
      let normalized = cleaned;
      if (/^0[1-9]\d{8}$/.test(cleaned)) normalized = '+33' + cleaned.slice(1);
      if (!/^\+33[1-9]\d{8}$/.test(normalized)) {
        return json({ error: 'forward_to_phone must be a valid French number' }, 400);
      }
      update.forward_to_phone = normalized;
    }

    if (Object.keys(update).length === 0) {
      return json({ error: 'No valid fields provided' }, 400);
    }

    // Update via service role (bypass RLS, mais on filtre par auth.uid juste avant)
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SB_SERVICE_ROLE_KEY')!,
    );

    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update({ ...update, updated_at: new Date().toISOString() })
      .eq('id', user.id)
      .select('business_name, sms_template, forward_to_phone')
      .single();

    if (error) {
      console.error('update-profile error:', error);
      return json({ error: error.message }, 500);
    }

    return json({ success: true, profile: data });
  } catch (err) {
    console.error('update-profile exception:', err);
    return json({ error: (err as Error).message }, 500);
  }
});
