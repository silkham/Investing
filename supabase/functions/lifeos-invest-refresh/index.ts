// lifeos-invest-refresh — server-side refresh of the LifeOS "Portfolio" tile.
//
// WHY THIS EXISTS: every LifeOS adapter publishes client-side, on app open, so a
// tile is only as fresh as the last time that source app was opened signed-in.
// Invest is the ONE metric that moves while the user is away (markets), so it
// gets a server path ON TOP of the in-app publishToLifeOS() adapter. This
// function fetches the T212 account summary and upserts the SAME lifeos.signals
// row publishToLifeOS() writes (app='invest', key='portfolio') — onConflict keeps
// it a single row, and the table's before-update trigger bumps updated_at, which
// LifeOS uses to show "updated Xh ago".
//
// INVOKED BY pg_cron (see migration 0003) hourly during UK market hours. The cron
// job POSTs with the SERVICE_ROLE key as the bearer: that both passes the
// platform JWT gate (verify_jwt stays ON — no public un-authed endpoint) AND lets
// the admin client bypass the authenticated-only RLS to write the row. No user
// session exists in a cron context, hence the service role.
//
// SAFETY (same discipline as t212-proxy): this calls ONLY the read endpoint
// /equity/account/cash. It must NEVER touch any T212 order/cancel endpoint.
// The T212 key/secret + service role live as Edge Function env secrets; nothing
// is returned to any client here (cron ignores the body).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const T212_BASE = "https://live.trading212.com/api/v0";
// Shared "Our household" — the same id publishToLifeOS() and every Project-A
// adapter write under. Project B has no household_memberships, so it's a constant.
const LIFEOS_HOUSEHOLD = "13b5e642-3f21-403c-8336-56976f177269";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

// Trading 212 auth = HTTP Basic (Base64 of KEY:SECRET) — CONFIRMED working in
// this project (see Investing CLAUDE.md; matches t212-proxy).
function t212AuthHeader(): string {
  const key = Deno.env.get("T212_API_KEY") ?? "";
  const secret = Deno.env.get("T212_API_SECRET") ?? "";
  return "Basic " + btoa(`${key}:${secret}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // 1) Fetch the T212 account summary (READ-ONLY path).
  let summary: Record<string, unknown>;
  try {
    const resp = await fetch(`${T212_BASE}/equity/account/cash`, {
      method: "GET",
      headers: { Authorization: t212AuthHeader(), Accept: "application/json" },
    });
    if (!resp.ok) return json({ error: `T212 ${resp.status}` }, 502);
    summary = await resp.json();
  } catch (e) {
    return json({ error: String(e) }, 502);
  }

  // Fields CONFIRMED on /equity/account/cash: total, invested, free, ppl, ...
  // `total` = portfolio value in £; `ppl` = unrealised P/L (already GBP).
  const total = (summary?.total as number | undefined) ?? null;
  if (total == null) return json({ error: "no total in T212 summary" }, 502);
  const ppl = (summary?.ppl as number | undefined) ?? null;
  const up = (ppl ?? 0) >= 0;
  const detail = ppl == null
    ? null
    : `${up ? "+" : "−"}£${Math.abs(ppl).toLocaleString("en-GB", { maximumFractionDigits: 0 })} P/L`;

  // 2) Upsert the SAME row shape publishToLifeOS() writes (service role bypasses
  //    the authenticated-only RLS). onConflict → one stable row, no duplicates.
  const row = {
    household_id: LIFEOS_HOUSEHOLD,
    app: "invest",
    kind: "metric",
    key: "portfolio",
    title: "Portfolio",
    detail,
    value: total,
    unit: "gbp",
    state: up ? "good" : "bad", // up = good for a portfolio
    cta_url: "https://silkham.github.io/Investing/",
    cta_label: "Open",
    status: "open",
  };

  const { error } = await admin
    .schema("lifeos")
    .from("signals")
    .upsert(row, { onConflict: "household_id,app,key" });
  if (error) return json({ error: error.message }, 500);

  return json({ ok: true, value: total, state: row.state, at: new Date().toISOString() });
});
