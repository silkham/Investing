-- LifeOS mirror on Project B (Investing DB, ref wqkhjbmsciuhwdqsdsni).
--
-- Investing is the single source app that lives on its OWN Supabase project;
-- every other app publishes into the `lifeos.signals` table on the shared
-- household DB (Project A). This creates an identical mirror table here so the
-- Investing adapter can publish its portfolio metric, and LifeOS's second,
-- read-only client (supaB) can read and merge it.
--
-- Difference from Project A's lifeos.signals: there is no household_memberships
-- table here, so the household-scoped RLS pattern (my_household_ids) does not
-- apply. This is a single-user personal DB, so RLS is simply authenticated-only:
-- reads and writes require a valid user JWT; nothing is exposed to the public
-- anon role, keeping the portfolio value private to the signed-in user.

create schema if not exists lifeos;

create table if not exists lifeos.signals (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  app          text not null,          -- always 'invest' here
  kind         text not null default 'metric',
  key          text not null,          -- stable per-signal id (e.g. 'portfolio')
  title        text not null,
  detail       text,
  value        numeric,                -- metric value: portfolio total in £
  unit         text,                   -- e.g. 'gbp'
  trend        numeric,                -- optional signed delta
  state        text,                   -- 'good' | 'warn' | 'bad' colour hint
  cta_url      text,                   -- deep link into the Investing app
  cta_label    text,
  due          date,
  sort_order   int not null default 0,
  status       text not null default 'open',
  updated_at   timestamptz not null default now(),
  unique (household_id, app, key)
);

create index if not exists idx_lifeos_signals_household on lifeos.signals (household_id);

create or replace function lifeos.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists trg_touch_signals on lifeos.signals;
create trigger trg_touch_signals before update on lifeos.signals
  for each row execute function lifeos.touch_updated_at();

-- Grants + RLS. Only the `authenticated` role gets schema/table access, so the
-- public anon key (committed in the client) cannot read the portfolio value.
grant usage on schema lifeos to authenticated;
grant select, insert, update, delete on lifeos.signals to authenticated;

alter table lifeos.signals enable row level security;
drop policy if exists lo_rw on lifeos.signals;
create policy lo_rw on lifeos.signals
  for all
  to authenticated
  using (true)
  with check (true);
