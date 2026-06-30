# The p2present sharing service (pastebin-lite)

> **This is the optional community-hosting backend.** p2present is a static site
> and works fully without it — you can always paste a URL / `ipfs://` / `magnet:`,
> build a manifest in the [Builder](https://ibeezhan.github.io/p2present/builder/),
> or [fork & self-host](README.md#fork--self-host). The service just adds a
> one-click **"Save & share" → short link** flow on top of that, for people who
> don't want to host a JSON file themselves.

The service is a small **[Cloudflare Worker](https://developers.cloudflare.com/workers/)
+ [KV](https://developers.cloudflare.com/kv/)** that stores `p2present.json`
manifests behind short ids. It lives in [`/service`](service/) and ships no
secrets. Anyone can deploy their own copy and point the app at it.

```
Author clicks "Save & share"
   → POST manifest to  <service>/api/p
   → gets { id, editToken }            (editToken kept in the author's browser)
   → shares  <service>/p/<id>          (a human link that redirects into the player)

Viewer opens  <service>/p/<id>  →  /app/?p=<id>  →  player fetches  <service>/api/p/<id>
```

---

## What it does

- **`POST /api/p`** — body is a `p2present.json`; returns `{ id, editToken, url, manifestUrl, ipfs?, expires? }`.
- **`GET /api/p/:id`** — returns the manifest JSON (what the player fetches).
- **`GET /p/:id`** — human-facing short link; `302`-redirects into the player (`/app/?p=<id>`).
- **`PUT /api/p/:id`** — update a manifest. Requires `Authorization: Bearer <editToken>`.
- **`DELETE /api/p/:id`** — delete it (same edit-token auth).
- **`POST /api/report`** — body `{ id, reason }`; records an abuse report and
  auto-hides a manifest once it passes `REPORT_HIDE_THRESHOLD`.
- **`GET /api/recent`** — ids of recent **public** manifests (unlisted ones are excluded).

**Built-in safety rails:** a manifest **size cap** (`413` over the limit), a
per-IP **rate limit** on writes (`429`), optional **expiry** (`?ttl=<seconds>`),
**public/unlisted** visibility, and **edit tokens stored only as a SHA-256 hash**
(the plaintext is returned once and kept by the author's browser).

---

## Deploy it

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and
[`wrangler`](https://developers.cloudflare.com/workers/wrangler/) (`npx wrangler`
works without a global install).

```bash
cd service

# 1. Create the KV namespaces (prod + preview) and copy the printed ids.
npx wrangler kv namespace create P2_KV
npx wrangler kv namespace create P2_KV --preview

# 2. Paste those ids into wrangler.toml  →  [[kv_namespaces]] id / preview_id

# 3. (optional) point the /p/<id> redirect at your player + tighten CORS:
#    edit [vars] APP_BASE and ALLOW_ORIGIN in wrangler.toml

# 4. Try it locally, then ship it.
npx wrangler dev        # http://127.0.0.1:8787
npx wrangler deploy
```

`wrangler deploy` prints your Worker URL (e.g.
`https://p2present.<account>.workers.dev`). That URL is your **service base**.

### Point a domain at it (e.g. `p2present.com`)

Add your domain to Cloudflare, then uncomment the `routes` block in
[`wrangler.toml`](service/wrangler.toml) so the Worker serves `…/api/*` and
`…/p/*` on your domain, and set `APP_BASE` to where your static player lives
(GitHub Pages, Cloudflare Pages, etc.). Redeploy. Now `https://yourdomain/p/<id>`
links work end to end.

---

## Point the app at your service

The app resolves its **service base URL** in this order (first match wins), so
self-hosters never have to edit code:

1. `?service=<base>` query param (per-link override; used by the smoke test).
2. `window.__P2_SERVICE_BASE` — set by a small inline `<script>` before `main.js`.
3. `<meta name="p2present:service" content="https://your-service">` in the page `<head>`.
4. `localStorage['p2present:service']` — a sticky per-browser override.
5. The built-in default placeholder (`https://p2present.com`).

For a fork, the simplest is a `<meta>` tag in `docs/app/index.html`:

```html
<meta name="p2present:service" content="https://p2present.<account>.workers.dev" />
```

---

## Optional: mirror to IPFS on save

Behind a config flag, the Worker can also pin every saved manifest to IPFS and
return an `ipfs://<cid>` alongside the short id (a durable, content-addressed
backup). It uses a pin-provider token you supply as a **secret** — never committed:

```bash
cd service
npx wrangler secret put IPFS_PIN_TOKEN      # e.g. a Pinata JWT
# then set IPFS_PIN = "true" in wrangler.toml [vars] and redeploy
```

The endpoint defaults to Pinata's `pinJSONToIPFS`; override with
`IPFS_PIN_ENDPOINT` if you use a different provider with the same API shape. If a
pin fails the save still succeeds — the response just carries an `ipfsError`
note instead of an `ipfs` CID.

---

## Configuration reference

All set in `wrangler.toml` `[vars]` (or as secrets where noted). Values are
strings; the defaults below apply when a var is absent.

| Key | Default | Meaning |
|-----|---------|---------|
| `P2_KV` *(binding)* | — | **Required.** KV namespace that stores manifests + counters. |
| `APP_BASE` | request origin + `/app/` | Where `/p/:id` redirects humans (your player). |
| `ALLOW_ORIGIN` | `*` | CORS `Access-Control-Allow-Origin`. Tighten to your app origin. |
| `MAX_BYTES` | `262144` | Manifest size cap (bytes); over → `413`. |
| `RATE_MAX` | `40` | Writes per window per IP; over → `429`. |
| `RATE_WINDOW` | `600` | Rate-limit window (seconds). |
| `MAX_TTL` | `31536000` | Max accepted `?ttl=` expiry (seconds). |
| `REPORT_HIDE_THRESHOLD` | `5` | Reports before a manifest auto-hides. |
| `IPFS_PIN` | `false` | `"true"` enables the IPFS mirror (needs the secret below). |
| `IPFS_PIN_TOKEN` *(secret)* | — | Pin-provider token (e.g. Pinata JWT). Set via `wrangler secret put`. |
| `IPFS_PIN_ENDPOINT` | Pinata `pinJSONToIPFS` | Pin API endpoint, if not Pinata. |

---

## <a id="make-permanent"></a>The "Make permanent" payment rail (Stripe)

The Host page's **arweave** provider offers pay-once **permanent** storage. When
the author supplies their own Arweave upload endpoint + credits, no payment is
needed — the file uploads directly. To offer a **"Make permanent 💎"** button that
*charges* the author and funds the upload for them, p2present ships a complete
**Stripe rail**: a sibling Cloudflare Worker
([`service/src/payments-worker.js`](service/src/payments-worker.js)) plus a
client adapter that the static site loads only when you point it at that Worker.
There are **no keys in the repo** — Stripe's secret key and webhook secret live
as Worker secrets, never in `docs/`.

### End-to-end flow

```
Host page  "Make permanent 💎"
  1. POST  <payments>/api/pay/checkout  { provider, bytes, name, returnUrl }
  2. Worker prices the upload, creates a Stripe Checkout Session, parks a
     job:<id> in KV (status=awaiting_payment), returns { jobId, url }
  3. Browser redirects to Stripe Checkout (Stripe.js not even required — it is
     a hosted redirect; the adapter can also confirm a PaymentIntent if you swap
     to an embedded flow).
  4. Author pays. Stripe POSTs  <payments>/api/pay/webhook  (signed).
  5. Worker verifies the signature, marks the job paid, and calls the deploy/
     control API  POST {PERSIST_CONTROL_URL}/jobs  → it funds the Arweave upload
     / pins to IPFS / seeds the torrent, returns a permanent ref (ar:// / ipfs://).
  6. Stripe sends the browser back to  returnUrl?p2pay=success&job=<id>.
     The Host page polls  <payments>/api/pay/result?jobId=<id>  until the ref is
     ready, then reflects it into the "Hosted references" list → Builder handoff.
```

Where the **bytes** go: the author stages the file with the control API (see
[`deploy/`](deploy/README.md)) before/at checkout; the webhook only authorises
the *persist* of an already-staged job. The Worker never proxies large uploads.

### Deploy the payments Worker

```bash
cd service

# 1. KV namespace for payment jobs (prod + preview); paste the ids into
#    wrangler.payments.toml → [[kv_namespaces]].
npx wrangler kv namespace create P2_PAY_KV           --config wrangler.payments.toml
npx wrangler kv namespace create P2_PAY_KV --preview --config wrangler.payments.toml

# 2. Stripe TEST-mode secrets (never committed). Keys: dashboard → Developers →
#    API keys. Webhook secret: see step 4.
npx wrangler secret put STRIPE_SECRET_KEY     --config wrangler.payments.toml   # sk_test_…
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.payments.toml   # whsec_…

# 3. (optional) the deploy/ control API the webhook drives:
npx wrangler secret put PERSIST_CONTROL_TOKEN --config wrangler.payments.toml
#    and set PERSIST_CONTROL_URL in wrangler.payments.toml [vars].

# 4. Run it. For the webhook secret, forward Stripe events locally with the CLI:
npx wrangler dev --config wrangler.payments.toml          # http://127.0.0.1:8787
stripe listen --forward-to http://127.0.0.1:8787/api/pay/webhook   # prints whsec_…

npx wrangler deploy --config wrangler.payments.toml       # → your payments base URL
```

Then register the production webhook in the Stripe dashboard pointing at
`<payments>/api/pay/webhook` (event `checkout.session.completed`) and copy its
signing secret into `STRIPE_WEBHOOK_SECRET`. Local config lives in `.dev.vars`
(gitignored — copy [`.dev.vars.example`](service/.dev.vars.example)).

### Point the Host page at it

The client resolves a **payments base URL** like the Save-&-share service base
(first match wins): `?payments=<base>` · `window.__P2_PAYMENTS_BASE` ·
`<meta name="p2present:payments" content="…">` · `localStorage['p2present:payments']`.
For a fork, the simplest is a `<meta>` tag in `docs/host/index.html`:

```html
<meta name="p2present:payments" content="https://p2present-payments.<account>.workers.dev" />
```

With a base configured, the **"Make permanent 💎"** button runs the real flow
above. With **none** configured, `makePermanent()` throws
`PaymentNotConfiguredError` and the Host page surfaces the actionable
"payment not configured" note — exactly the static-build default. You can still
override the rail entirely by injecting your own adapters before the page scripts:

```html
<script>
window.__P2_PAYMENTS = {
  async onchain({ file }) {                 // on-chain rent (see CRYPTO-PAYMENTS.md)
    const price = await irys.getPrice(file.size);
    const tx = await irys.fund(price);      // wallet signs
    return { receipt: tx.id };
  },
};
</script>
```

**Adapter contract.** Each adapter receives `{ provider, file, onProgress }` and
returns `{ receipt }` once funded; the Stripe adapter redirects and is resumed by
`resumePendingPermanent()` on return. `makePermanent()` prefers `onchain` when
both are present (override per call with `method`). Keep all keys server-side / in
the wallet — never in the committed site.

> The two concerns are independent: the **upload endpoint** (where bytes go) is
> the arweave provider's config; the **payment rail** (who pays) is the payments
> Worker. Configure the endpoint for self-funded uploads, the Worker for a paid
> button, or both. The on-chain rail is designed but not implemented — see
> [CRYPTO-PAYMENTS.md](CRYPTO-PAYMENTS.md).

---

## Tests

Both Workers' handler logic is covered by unit tests against a Map-backed mock
KV and a stubbed Stripe + control API (no network, no real Cloudflare):

```bash
cd service && npm test          # node --test "test/*.test.mjs"
# → pastebin handlers (worker.test.mjs) + the payments rail (payments.test.mjs):
#   pricing, checkout, webhook signature verify, payment→persist, idempotency.
```

The repository's top-level `npm test` runs these alongside the app's unit tests,
and `npm run smoke` exercises the **Save & share** + `?p=<id>` service-load paths
in headless Chrome against a mock service.
