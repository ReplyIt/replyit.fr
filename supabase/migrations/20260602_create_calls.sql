-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  Migration Airtable → Postgres : table `calls` (leads/appels)      ║
-- ║  Remplace la table Airtable `client_data`.                          ║
-- ╚══════════════════════════════════════════════════════════════════╝
--
-- Modèle :
--   profiles (TES clients = artisans)  1 ──< many  calls (leurs prospects/appels)
--   Chaque ligne = 1 appel capté (manqué ou décroché).
--
-- À exécuter dans Supabase → SQL Editor (ou `supabase db push`).

create table if not exists public.calls (
  id           uuid primary key default gen_random_uuid(),
  call_sid     text unique,                              -- ex 'Call ID' Airtable (dédup atomique)
  phone        text not null,                            -- 'Numéro client' (n° du prospect)
  occurred_at  timestamptz not null default now(),       -- 'Heure d'appel'
  message      text,                                     -- 'Message prospect' (rempli via Tally)
  statut       text not null default 'À rappeler',       -- 'Statut'
  montant      numeric,                                  -- 'Montant' (€ du deal converti)
  type         text not null default 'Manqué',           -- 'Type' : 'Manqué' | 'Décroché'
  rappele_le   timestamptz,                              -- 'Rappelé le' (KPI délai moyen)
  user_id      uuid references public.profiles(id) on delete set null,  -- l'artisan propriétaire
  client_email text not null,                            -- 'Email client' (dénormalisé / fallback)
  created_at   timestamptz not null default now()
);

create index if not exists calls_user_occurred_idx  on public.calls (user_id, occurred_at desc);
create index if not exists calls_email_occurred_idx on public.calls (client_email, occurred_at desc);
create index if not exists calls_phone_occurred_idx on public.calls (phone, occurred_at desc);

-- ── RLS : un client ne voit QUE ses propres appels ──
-- (les écritures passent par les Edge Functions en service_role, qui bypasse la RLS)
alter table public.calls enable row level security;

drop policy if exists "calls_select_own" on public.calls;
create policy "calls_select_own" on public.calls
  for select using (auth.uid() = user_id);

-- ── Seed démo (compte arthurdupont) : garde le dashboard de démo peuplé ──
-- N'insère rien si le profil n'existe pas. Idempotent grâce aux call_sid 'seed-*'.
insert into public.calls (call_sid, phone, occurred_at, statut, montant, type, message, user_id, client_email)
select v.call_sid, v.phone, now() - v.ago, v.statut, v.montant, v.type, v.message, p.id, p.email
from public.profiles p
cross join (values
  ('seed-1', '+33769390252', interval '19 hours', 'Converti',   540, 'Manqué',   null),
  ('seed-2', '+33616190589', interval '20 hours', 'Rappelé',    null, 'Manqué',  null),
  ('seed-3', '+33749210925', interval '21 hours', 'À rappeler', null, 'Manqué',  'Bonjour, devis pour une salle de bain'),
  ('seed-4', '+33685411836', interval '23 hours', 'À rappeler', null, 'Manqué',  null),
  ('seed-5', '+33662554916', interval '25 hours', 'Converti',   320, 'Manqué',   'Fuite urgente cuisine'),
  ('seed-6', '+33651112233', interval '26 hours', 'Sans suite', null, 'Manqué',  null),
  ('seed-7', '+33769390252', interval '1 hour',   'Converti',   122, 'Décroché', null)
) as v(call_sid, phone, ago, statut, montant, type, message)
where p.email = 'arthurdupont@yopmail.com'
on conflict (call_sid) do nothing;
