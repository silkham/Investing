-- Server-side hourly refresh of the LifeOS "Portfolio" tile (Project B only).
--
-- WHY: every LifeOS adapter publishes client-side, on app open, so a tile is only
-- as fresh as the last time that app was opened signed-in. Invest is the ONE
-- metric that moves while the user is away (markets), so it gets a server path on
-- top of the in-app publishToLifeOS(): pg_cron periodically POSTs to the
-- `lifeos-invest-refresh` Edge Function, which fetches the T212 account summary
-- and upserts the SAME lifeos.signals portfolio row. The table's before-update
-- trigger bumps updated_at, which LifeOS renders as "updated Xh ago".
--
-- SECRET HANDLING (this repo is PUBLIC — no secret may be committed):
-- the http_post needs the service_role key as its bearer, so it is stored in
-- Supabase Vault and read by NAME here — the key itself never appears in this
-- file. Provision the secret out-of-band ONCE (Mgmt API / SQL editor, not in a
-- committed migration):
--     select vault.create_secret('<service_role_jwt>', 'lifeos_service_role_key');
-- (Already provisioned on ref wqkhjbmsciuhwdqsdsni.)

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- service_role bypasses RLS but still needs schema/table GRANTs (the 0002 mirror
-- migration granted only `authenticated`). The cron function upserts as service
-- role, so grant it here.
grant usage on schema lifeos to service_role;
grant select, insert, update, delete on lifeos.signals to service_role;

-- Hourly during UK market hours, weekdays. cron runs in UTC and the UK shifts
-- BST(+1, summer) / GMT(+0, winter); the LSE trades ~08:00-16:30 LOCAL. `7-16`
-- UTC deliberately covers both regimes (BST: 08:00-17:00 local; GMT: 07:00-16:00
-- local) rather than hardcoding one offset that breaks half the year.
select cron.unschedule('lifeos-invest-refresh')
  where exists (select 1 from cron.job where jobname = 'lifeos-invest-refresh');

select cron.schedule(
  'lifeos-invest-refresh',
  '0 7-16 * * 1-5',
  $job$
    select net.http_post(
      url     := 'https://wqkhjbmsciuhwdqsdsni.supabase.co/functions/v1/lifeos-invest-refresh',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'lifeos_service_role_key'
        )
      ),
      body    := '{}'::jsonb
    ) as request_id;
  $job$
);
