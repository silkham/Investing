-- Portfolio Intelligence Dashboard — v0.1 schema
-- Lives inside the shared `realestate` Supabase project, so every table is
-- namespaced `inv_` to avoid colliding with real-estate tables.
-- Single-user app: RLS locks every row to the authenticated owner.

-- ---------------------------------------------------------------------------
-- API response cache. Written by Edge Functions (service role), read by the
-- client. Not user-scoped — one owner — but RLS still requires auth to read.
-- ---------------------------------------------------------------------------
create table if not exists public.inv_api_cache (
  cache_key    text primary key,           -- e.g. 't212:summary', 't212:positions'
  source       text not null,              -- 't212' | 'finnhub' | 'twelvedata'
  payload      jsonb not null,
  fetched_at   timestamptz not null default now(),
  ttl_seconds  integer not null
);

comment on table public.inv_api_cache is
  'Cached third-party API responses. Freshness = now() - fetched_at < ttl_seconds.';

-- ---------------------------------------------------------------------------
-- Allocation targets — the discipline model. One row per owner.
-- Percentages are of total portfolio value.
-- ---------------------------------------------------------------------------
create table if not exists public.inv_settings (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  core_min_pct        numeric not null default 50,   -- global tracker floor (VWRP)
  satellite_max_pct   numeric not null default 25,   -- researched sleeve cap
  fun_max_pct         numeric not null default 5,    -- money-you-can-lose cap
  per_name_cap_pct    numeric not null default 10,   -- single-position ceiling
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Per-holding thesis + falsification note. Surfaced next to the position and
-- again at sell-consideration time (v0.2 sell-friction). Created now so the
-- schema is stable from commit 1.
-- ---------------------------------------------------------------------------
create table if not exists public.inv_theses (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  ticker          text not null,
  sleeve          text,                     -- 'core' | 'satellite' | 'fun'
  thesis          text,
  prove_me_wrong  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, ticker)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.inv_api_cache enable row level security;
alter table public.inv_settings  enable row level security;
alter table public.inv_theses    enable row level security;

-- Cache: any authenticated user may read; writes come from the Edge Function
-- via the service-role key, which bypasses RLS (so no write policy needed).
drop policy if exists inv_api_cache_read on public.inv_api_cache;
create policy inv_api_cache_read on public.inv_api_cache
  for select to authenticated using (true);

-- Settings: owner-only, full access.
drop policy if exists inv_settings_owner on public.inv_settings;
create policy inv_settings_owner on public.inv_settings
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Theses: owner-only, full access.
drop policy if exists inv_theses_owner on public.inv_theses;
create policy inv_theses_owner on public.inv_theses
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
