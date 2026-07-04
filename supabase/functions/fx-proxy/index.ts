// fx-proxy — GBP-base foreign-exchange rates with Postgres caching.
//
// Why this exists: Trading 212 reports each position's price in the
// instrument's NATIVE currency (VWRP in GBP, US names in USD, …). To show a
// correct GBP value and allocation %, the client converts foreign holdings
// using the rates this function returns.
//
// Source: Frankfurter (https://frankfurter.dev) — free, KEYLESS, ECB reference
// rates updated once per working day. No secret required. Adequate for a
// long-term ISA dashboard where currencies move fractions of a percent a day.
//
// Caching: the response is stored in inv_api_cache (12h TTL). Within the TTL we
// serve the cached copy and never hit the upstream.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// base=GBP → rates are "1 GBP = <rate> <ccy>". To convert a foreign amount to
// GBP the client divides by the rate. GBP itself is implicitly 1.
const FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest?base=GBP";
const CACHE_KEY = "fx:gbp";
const TTL = 12 * 60 * 60; // 12h

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Verify the caller's Supabase JWT (single-user app, but don't run open).
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Missing bearer token" }, 401);

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

  // 1) Serve fresh cache if within TTL.
  const { data: cached } = await admin
    .from("inv_api_cache")
    .select("payload, fetched_at, ttl_seconds")
    .eq("cache_key", CACHE_KEY)
    .maybeSingle();

  if (cached) {
    const ageMs = Date.now() - new Date(cached.fetched_at as string).getTime();
    if (ageMs < (cached.ttl_seconds as number) * 1000) {
      const p = cached.payload as Record<string, unknown>;
      return json({ ...p, fetched_at: cached.fetched_at, cached: true });
    }
  }

  // 2) Cache miss/stale → fetch from Frankfurter.
  try {
    const resp = await fetch(FRANKFURTER_URL, { headers: { Accept: "application/json" } });
    if (!resp.ok) {
      if (cached) {
        const p = cached.payload as Record<string, unknown>;
        return json({ ...p, fetched_at: cached.fetched_at, cached: true, stale: true });
      }
      return json({ error: `frankfurter ${resp.status}` }, 502);
    }

    // { amount:1, base:"GBP", date:"YYYY-MM-DD", rates:{ USD:.., EUR:.., ... } }
    const raw = await resp.json();
    const payload = { base: raw.base, date: raw.date, rates: raw.rates };
    const fetched_at = new Date().toISOString();

    await admin.from("inv_api_cache").upsert({
      cache_key: CACHE_KEY,
      source: "frankfurter",
      payload,
      fetched_at,
      ttl_seconds: TTL,
    });

    return json({ ...payload, fetched_at, cached: false });
  } catch (e) {
    if (cached) {
      const p = cached.payload as Record<string, unknown>;
      return json({ ...p, fetched_at: cached.fetched_at, cached: true, stale: true });
    }
    return json({ error: String(e) }, 502);
  }
});
