---
project: Portfolio Dashboard
status: active
last_updated: 2026-07-04
next_milestone: Verify FX in-browser against live ISA data
repo: https://github.com/silkham/Investing
live_url: https://silkham.github.io/Investing/
---

# CLAUDE.md — Portfolio Intelligence Dashboard

<!-- The Status and Roadmap sections below are read by the Project Dashboard.
     Keep them current: Status = where it is now, Roadmap = what's planned.
     Changelog is pulled live from git commit history, so don't maintain one here. -->

## Status
Backend is live on the shared `realestate` Supabase project and the full pipeline
returns real ISA data end-to-end: T212 positions + account summary through a
read-only proxy, allocation/drift rails, and FX conversion of non-GBP holdings to
GBP via keyless ECB rates. FX is deployed and shape-verified but not yet eyeballed
against live data in-browser. v0.1 (read-only dashboard) is functionally complete.
The v0.2 discipline layer has started: allocation targets are now editable in-app
(modal → `inv_settings`) and each holding has a thesis / "what would prove me wrong" /
sleeve editor (modal → `inv_theses`); the sleeve you assign drives the drift model.
PWA install icons are in place. (v0.2 UI is code-verified but not yet eyeballed in a
live browser — same login blocker as FX.)

## Roadmap
- [ ] Verify FX in-browser against live ISA data (US names' GBP value, satellite %, ccy badge)
- [x] Add PWA icons `icon-192.png` / `icon-512.png` (maskable, allocation-rail motif on theme green)
- [x] v0.2: editable allocation targets + per-holding thesis UI (targets modal → inv_settings;
      per-holding thesis/"prove me wrong"/sleeve modal → inv_theses)
- [ ] v0.2: cost & turnover tracker + trade log
- [ ] v0.3: research enrichment per held ticker (consensus, earnings, insider activity)

## Your role

You are a **financial data engineer**. You build a personal, single-user decision-support
dashboard: you wire up data pipelines faithfully, present them clearly, and leave every
buy/sell/hold decision to the user. You are NOT a trading advisor and this app is NOT an
advice engine.

**Hard rule that shapes every feature:** the app surfaces data (prices, positions, consensus,
fundamentals, insider activity, macro events) and *interprets what the data means* in plain
English. It never emits a recommendation, signal, target, or the words "buy" / "sell" / "hold"
as an instruction to the user. Aggregated third-party consensus (e.g. "24 of 32 analysts rate
Buy") may be *displayed as reported fact*, always attributed and dated — but the app never adds
its own verdict on top. When in doubt, show the data and the caveat, not a conclusion.

The user does all actual trading in the Trading 212 app. This dashboard is read-only.

## Who this is for

A single user (the owner), new to investing, running a Trading 212 Stocks & Shares ISA. Core
strategy: 50%+ in a global tracker (Vanguard FTSE All-World, VWRP), a ~25% "satellite" sleeve
of researched individual positions, and a small "fun" sleeve treated as money that can be lost
entirely. The app's job is to keep him disciplined, informed, and honest with himself — not to
make him trade more.

## Design ethos (why the app leans toward *less* action)

The evidence is consistent: retail investors underperform mainly through over-trading, return-
chasing, and panic-selling — not through bad information. So this dashboard's highest-value
features are the ones that *slow the user down*: a written thesis per holding, a "what would
prove me wrong" note, drift rails, a cost-of-trading tracker, and friction before selling.
Build these as first-class, not afterthoughts. The app is a discipline engine first and a data
feed second.

## Tech stack (match the user's existing projects)

- **Single-file HTML PWA** — one `index.html`, vanilla JS, no build step. (Same pattern as the
  user's Strive and Partner Tracker apps.)
- **Supabase** — Postgres for stored data (theses, targets, trade log, cached API responses)
  + **Edge Functions** as server-side proxies for every third-party API. Auth via Supabase.
- **GitHub Pages** — static hosting. Repo linked to Claude Code.
- **PWA** — installable, offline-capable for the discipline/log features (cached data is fine
  when offline; live panels show a "last updated" stamp).

## CRITICAL: secrets and safety

- **No API key or secret ever touches the client HTML.** All third-party calls go through
  Supabase Edge Functions that hold the keys as environment secrets.
- **The Trading 212 key can place trades. This app must only ever READ.** Never call any T212
  order/cancel endpoint anywhere in the codebase. Restrict the key to read use, and (in setup
  docs) tell the user to enable T212's IP restriction on the key.
- Rate limits are real — cache aggressively (see below). Never hammer an endpoint on render.

## Data sources — who answers what

Keep these strictly separate; they answer different questions.

**Trading 212 API = "where I actually am."**
- Base: `https://live.trading212.com/api/v0` — HTTP Basic auth (Base64 of `KEY:SECRET`).
- ISA account only for this app. Use: account summary (total value, invested, cash, P/L) and
  positions (ticker, quantity, average price, current value, unrealised P/L).
- Custom T212 tickers: always resolve via the instruments endpoint; cache instruments to
  Postgres (it's ~5MB, ~50s rate limit) and refresh at most hourly. Never build tickers by hand.
- This is the source of truth for *what the user owns*. It provides NO research/news/fundamentals.

**Finnhub (free tier) = "the world's view of what I own."** US-listed symbols only on free tier.
- `/quote` — delayed/real-time US quote.
- `/stock/metric?metric=all` — fundamentals (margins, growth, debt, valuation) → trap filter.
- `recommendation-trends` — analyst consensus buckets (strongBuy/buy/hold/sell/strongSell) over
  time. Display as attributed, dated fact. **Always** render alongside a persistent caveat that
  Sell ratings are structurally rare, so "mostly Buy" is the norm, not a signal.
- Earnings calendar, company news, **insider transactions**, congressional trading.
- Price *targets* are premium-gated — leave a labelled stub, don't wire it.
- Limit: 60 calls/min. Cache everything (see below).

**Twelve Data (free) = fallback** for LSE/UCITS quotes Finnhub misses (e.g. VWRP itself).
Expect delayed data. Reconcile the user's core ETF end-of-day.

**Pipeline shape:** T212 gives the list of held tickers → the app enriches each held ticker with
Finnhub research/news/insider data. Positions drive everything; the research layer hangs off them.

## On "trusted analysts" — deliberately NOT a pundit list

Do not build a feature that aggregates named public "gurus" (FinTwit/YouTube). Visibility and
reliability are inversely correlated and it would build a pump-susceptible herd machine. Instead,
the trustworthy, legally-clean signal is **what real money actually did**: Finnhub insider
transactions (director buys/sells) and congressional trading, shown as dated fact on the user's
holdings. If the user later wants named voices, allow *him* to nominate a small set and merely
link their public output — clearly walled off and labelled "opinion, not data."

## Caching (do this from commit 1, not later)

- Every Edge Function writes its response to a Postgres cache table with a timestamp + TTL.
- TTLs (starting point): T212 positions 60s; instruments 1h; quotes 60s; fundamentals 24h;
  consensus 12h; news 1h; insider/congressional 24h; macro calendar 12h.
- Every live panel in the UI shows a "last updated HH:MM" stamp. Offline = show cached + stamp.

## Features / build order

**v0.1 — foundations**
- Supabase project + auth (single user). Edge Function proxy scaffold + cache table.
- T212 positions + account summary pulling through the proxy → holdings table in the UI with
  value and unrealised P/L. This replaces manual entry entirely for the ISA.
- Target-allocation model: user sets targets (e.g. core ≥50%, satellite cap, per-name cap);
  app computes actual vs target and shows **drift** + over-concentration flags.

**v0.2 — discipline layer (the real value)**
- Per-holding **thesis** + **"what would prove me wrong"**, stored in Postgres, shown next to
  the position and surfaced again at sell-consideration time (sell-friction interstitial).
- **Cost & turnover tracker**: estimate FX/spread/turnover cost of trading on the actual
  balance; show annualised drag. A trade log with a one-line "why" per entry.
- Monthly **behaviour mirror**: your own trades reviewed — sold winners early? bought dips?

**v0.3 — research enrichment (per held ticker)**
- Consensus trend (+ mandatory caveat), earnings date, news filtered to holdings, fundamentals.
- Insider + congressional activity on holdings ("what the smart money did").
- Small-cap **trap filter** for the fun sleeve: flag cash runway, debt, dilution, extreme
  valuation. Defence, not stock-picking. Hard per-name position cap enforced in the UI.

**v0.4 — morning intelligence + PWA**
- Single "morning brief" screen: where you are · what's happening to what you own · what smart
  money did · what matters today (macro calendar w/ plain-English "why this touches an All-World
  holder" notes). Read over coffee; act in the T212 app.
- PWA install + offline for discipline/log features. Contextual explainers (P/E, why All-World
  tilts US, rebalancing) so the app teaches the framework as you go.

## UI / design direction

- Match the user's taste: minimalist, understated, premium, well-considered — borderless tiles,
  restraint over decoration, one confident type pairing, generous spacing. Not a Bloomberg-
  terminal wall of numbers; a calm morning dashboard.
- Follow the frontend-design skill: pick a deliberate palette (4–6 named hex), a display/body/
  data type trio, and one signature element. Avoid the AI-default cream+serif+terracotta look.
- Copy: plain, active voice, sentence case. Empty states invite action. Never sell; describe.
- Quality floor: responsive to mobile, visible keyboard focus, reduced-motion respected,
  "last updated" stamps on live data.

## Session workflow

- Keep this file current as the persistent project brief. At the end of a working session,
  update a short "state / next steps" note (below) so the next session resumes cleanly.
- Prefer small, reviewable commits per feature. Never commit secrets.

## State / next steps

**Backend:** reuse the existing **`realestate`** Supabase project
(ref `wqkhjbmsciuhwdqsdsni`, ACTIVE_HEALTHY) — all tables namespaced `inv_` to
avoid collisions. Deploy functions with
`supabase functions deploy <name> --project-ref wqkhjbmsciuhwdqsdsni`.

**Hosting (live):** repo is **PUBLIC** on GitHub — `github.com/silkham/Investing`
(`origin`, `main` tracks `origin/main`). Served via **GitHub Pages** from `main`/root
at **https://silkham.github.io/Investing/**; a push to `main` auto-deploys. Pages
required a public repo (free plan). Manifest/assets are referenced RELATIVELY so they
resolve under the `/Investing/` subpath — keep them relative.

**Done (v0.1 scaffold, local only — nothing deployed, placeholders for keys):**
- `git init`, `.gitignore` (secrets ignored).
- `supabase/migrations/0001_investing_v01.sql` — `inv_api_cache`, `inv_settings`
  (allocation targets), `inv_theses`; RLS owner-scoped.
- `supabase/functions/t212-proxy/index.ts` — read-only T212 proxy, write-through
  cache to `inv_api_cache` (60s TTL), JWT-verified, stale-fallback on upstream error.
  Read endpoints only (`/equity/account/cash`, `/equity/portfolio`).
- `index.html` — PWA shell: Supabase email/password auth, summary tiles, holdings
  table, allocation/drift rails + per-name concentration flags. Offline banner +
  "last updated" stamp. Placeholders `__SUPABASE_URL__` / `__SUPABASE_ANON_KEY__`.
- `manifest.webmanifest`, `SETUP.md` (deploy + secrets + safety steps).

**DEPLOYED & VERIFIED (2026-07-04):** backend is live on `realestate` and the full
pipeline returns real ISA data end-to-end.
- Schema applied (RLS on all 3 `inv_` tables). Function `t212-proxy` deployed.
  Client wired with URL + anon key. T212 secrets set. Auth user exists
  (`lachlanmclean1990@gmail.com`) and signs in.
- **T212 auth scheme CONFIRMED = HTTP Basic** (`Base64(KEY:SECRET)`) — works, no 401.
- **T212 response fields CONFIRMED:**
  - summary (`/equity/account/cash`): `total, invested, free, ppl, blocked, pieCash`.
    total = invested + blocked + ppl; `free` = cash.
  - positions (`/equity/portfolio`): array of `{ticker, quantity, averagePrice,
    currentPrice, ppl, fxPpl, ...}`. No GBP `value` field — we compute qty×price.

**FX conversion — DONE (2026-07-04):** non-GBP holdings now convert to GBP.
- `fx-proxy` Edge Function: keyless ECB rates from Frankfurter (base=GBP), cached
  12h in `inv_api_cache` (key `fx:gbp`, source `frankfurter`), JWT-verified. No secret.
- `t212-proxy` gained a read-only `instruments` endpoint (`/equity/metadata/instruments`),
  reduced server-side to a compact `{ticker: currencyCode}` map (raw is ~5MB), cached 24h
  (key `t212:instruments_ccy`). AUTHORITATIVE currency per holding — do NOT parse currency
  from ticker suffixes.
- Client `toGBP(amount, ccy)`: GBP→as-is; GBX/GBp→÷100 (pence); else ÷rate. `ppl` left
  untouched (already GBP). Foreign rows show a ccy badge + ECB-rate note.
- NOTE: deployed & shape-verified (Frankfurter payload, rate direction), but NOT yet
  eyeballed against live ISA data in-browser (sandbox blocks the static server; needs login).

**Landmines:**
- **Currency (mostly handled):** conversion needs both the T212 `instruments` map and the
  Frankfurter rates loaded before `normalizePositions()` runs (they are, in `loadPortfolio`).
  If either fails, foreign values silently fall back to NATIVE (wrong but not blank) — the
  ccy badge on a row confirms conversion actually happened.
- **Repo is PUBLIC.** Never commit any secret — only the public-safe Supabase anon
  key belongs in the client. All third-party keys stay as Edge Function secrets.
- Restoring a paused free-tier project can come back on a bad PG build
  (`supautils.so: undefined symbol`) — a project **restart** cleared it. Not our bug.

**Next steps:**
1. Verify FX in-browser against live ISA data (open the hosted URL + sign in);
   confirm US names' GBP value and satellite % look right and the ccy badge shows.
2. Add PWA icons `icon-192.png` / `icon-512.png` (manifest references them; missing).
3. v0.2: editable targets + thesis UI (schema already exists).
