// t212-proxy — read-only Trading 212 proxy with Postgres caching.
//
// SAFETY (non-negotiable, see CLAUDE.md):
//   • This function calls ONLY read endpoints. It must NEVER touch any T212
//     order/cancel endpoint. The allow-list below is the enforcement point.
//   • The T212 key/secret live as Edge Function env secrets and never reach
//     the client. The client calls this function with its Supabase JWT.
//
// Caching: responses are stored in inv_api_cache with a TTL. Within the TTL we
// serve the cached copy and never hit T212 (rate limits are real).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const T212_BASE = "https://live.trading212.com/api/v0";

// Only these read endpoints may ever be called. No order/cancel paths exist here.
// `reduce` (optional) shrinks a large upstream payload before we cache/return it.
const ENDPOINTS = {
  summary:   { path: "/equity/account/cash", cacheKey: "t212:summary",   ttl: 60 },
  positions: { path: "/equity/portfolio",    cacheKey: "t212:positions", ttl: 60 },
  // Instrument metadata. Read-only (never build tickers by hand — CLAUDE.md).
  // The raw payload is ~5MB, so we reduce it to a compact
  // { ticker: { ccy, name, sym } } map: currency drives GBP conversion, name/sym
  // give the client a human-friendly label instead of the raw T212 ticker.
  // Rate-limited (~50s) upstream, so cache for 24h.
  instruments: {
    path: "/equity/metadata/instruments",
    cacheKey: "t212:instruments_meta",
    ttl: 24 * 60 * 60,
    reduce: (raw: unknown): Record<string, { ccy: string; name?: string; sym?: string }> => {
      const out: Record<string, { ccy: string; name?: string; sym?: string }> = {};
      if (Array.isArray(raw)) {
        for (const i of raw) {
          if (!i?.ticker) continue;
          out[i.ticker] = { ccy: i.currencyCode, name: i.name, sym: i.shortName };
        }
      }
      return out;
    },
  },
} as const;

type Which = keyof typeof ENDPOINTS;

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

// Trading 212 auth. CLAUDE.md specifies HTTP Basic (Base64 of KEY:SECRET).
// NOTE: some T212 docs show a bare `Authorization: <apiKey>` header instead —
// verify against the live docs when real keys are wired (see SETUP.md).
function t212AuthHeader(): string {
  const key = Deno.env.get("T212_API_KEY") ?? "";
  const secret = Deno.env.get("T212_API_SECRET") ?? "";
  return "Basic " + btoa(`${key}:${secret}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // --- Authenticate the caller (single-user app, but still verify the JWT) ---
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Missing bearer token" }, 401);

  const admin = createClient(supabaseUrl, serviceKey);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

  // --- Which read endpoints? Default: both. ---
  let want: Which[] = ["summary", "positions"];
  try {
    const body = await req.json();
    if (Array.isArray(body?.want)) {
      want = body.want.filter((w: string): w is Which => w in ENDPOINTS);
    }
  } catch {
    // no body → defaults
  }
  if (want.length === 0) return json({ error: "Nothing to fetch" }, 400);

  const result: Record<string, unknown> = {};

  for (const which of want) {
    const cfg = ENDPOINTS[which];
    const { path, cacheKey, ttl } = cfg;
    const reduce = "reduce" in cfg ? cfg.reduce : undefined;

    // 1) Serve fresh cache if within TTL.
    const { data: cached } = await admin
      .from("inv_api_cache")
      .select("payload, fetched_at, ttl_seconds")
      .eq("cache_key", cacheKey)
      .maybeSingle();

    if (cached) {
      const ageMs = Date.now() - new Date(cached.fetched_at as string).getTime();
      if (ageMs < (cached.ttl_seconds as number) * 1000) {
        result[which] = { data: cached.payload, fetched_at: cached.fetched_at, cached: true };
        continue;
      }
    }

    // 2) Cache miss/stale → fetch from T212 (read-only path).
    try {
      const resp = await fetch(`${T212_BASE}${path}`, {
        method: "GET",
        headers: { Authorization: t212AuthHeader(), Accept: "application/json" },
      });

      if (!resp.ok) {
        // On upstream error, fall back to stale cache if we have any.
        if (cached) {
          result[which] = { data: cached.payload, fetched_at: cached.fetched_at, cached: true, stale: true };
        } else {
          result[which] = { error: `T212 ${resp.status}`, cached: false };
        }
        continue;
      }

      const raw = await resp.json();
      const payload = reduce ? reduce(raw) : raw;
      const fetched_at = new Date().toISOString();

      // 3) Write-through to cache.
      await admin.from("inv_api_cache").upsert({
        cache_key: cacheKey,
        source: "t212",
        payload,
        fetched_at,
        ttl_seconds: ttl,
      });

      result[which] = { data: payload, fetched_at, cached: false };
    } catch (e) {
      if (cached) {
        result[which] = { data: cached.payload, fetched_at: cached.fetched_at, cached: true, stale: true };
      } else {
        result[which] = { error: String(e), cached: false };
      }
    }
  }

  return json(result);
});
