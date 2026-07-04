# Setup — Portfolio Intelligence Dashboard (v0.1)

Single-user, read-only dashboard. Backend lives inside the existing **`realestate`**
Supabase project (ref `wqkhjbmsciuhwdqsdsni`); all tables are namespaced `inv_`.

## 0. Prerequisites
- Supabase CLI (installed) and logged in.
- The `realestate` project is currently **INACTIVE** — resume it in the Supabase
  dashboard before deploying, or the DB/functions won't respond.

## 1. Apply the database schema
Creates `inv_api_cache`, `inv_settings`, `inv_theses` with RLS.

```bash
supabase link --project-ref wqkhjbmsciuhwdqsdsni
supabase db push
```

## 2. Deploy the Edge Functions

```bash
supabase functions deploy t212-proxy --project-ref wqkhjbmsciuhwdqsdsni
supabase functions deploy fx-proxy   --project-ref wqkhjbmsciuhwdqsdsni
```

`fx-proxy` needs **no secret** — it fetches keyless ECB rates from Frankfurter
(https://frankfurter.dev) to convert non-GBP holdings (e.g. US names in USD) to
GBP. `t212-proxy` also serves an `instruments` map (ticker → currency) used for
that conversion.

## 3. Set the server-side secrets (NEVER in the client)

```bash
supabase secrets set --project-ref wqkhjbmsciuhwdqsdsni \
  T212_API_KEY="your-t212-key" \
  T212_API_SECRET="your-t212-secret"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected into Edge Functions
automatically — you do NOT set those.

### Trading 212 key — safety
- **Use a READ-only key** (no order-execution scope). This app never calls any
  order/cancel endpoint, and the key should be scoped to read as defence-in-depth.
- **IP restriction is NOT practical here.** The API is called by the Supabase Edge
  Function (Supabase's cloud), not your device, and free-tier functions have no stable
  egress IP to pin. Restricting to your home IP would break the app. Read-only scope is
  the real protection.
- Auth scheme: **HTTP Basic (`Base64(KEY:SECRET)`) — confirmed working** against the
  live API (2026-07-04). Defined in `t212AuthHeader()` in
  `supabase/functions/t212-proxy/index.ts`.

## 4. Configure the client
In **`index.html`**, replace the two placeholders near the top of the `<script>`:

```js
const SUPABASE_URL = "https://wqkhjbmsciuhwdqsdsni.supabase.co";
const SUPABASE_ANON_KEY = "your-anon-key";  // public-safe; RLS enforces access
```

Get the anon key from: Supabase dashboard → realestate → Project Settings → API.

## 5. Create the single user
In the Supabase dashboard → Authentication → Users → **Add user** (your email +
password). That's the only login.

## 6. Run it
Serve the folder statically (or open via a local server) and sign in:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

Deploy target is GitHub Pages (static). Add `icon-192.png` / `icon-512.png` for a
clean PWA install.

## Not wired yet (later versions)
- Finnhub / Twelve Data proxies (v0.3 research, v0.1 fallback quotes).
- Service worker for true offline (v0.4). The app already shows cached data + a
  "last updated" stamp and an offline banner.
- Editable targets & thesis UI (v0.2) — schema is in place.
