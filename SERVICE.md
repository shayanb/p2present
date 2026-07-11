# The p2present sharing service (pastebin-lite)

> **This is the optional community-hosting backend.** p2present is a static site
> and works fully without it — you can always paste a URL / `ipfs://` / `magnet:`,
> build a manifest in the [Builder](https://p2present.com/builder/),
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

### Or: deploy on git push (Workers Builds)

If the GitHub repo is connected to the Worker (dashboard → your Worker →
**Settings → Build**), every push to the production branch deploys it — no
local wrangler needed. Configure the build like this:

- **Root directory:** `/service`
- **Deploy command:** `npx wrangler deploy`
- **Build watch paths:** `service/**` — so site-only pushes (docs/) don't
  trigger a Worker deploy.

Two things still have to be true for the build to succeed:

1. The **KV namespace ids in `wrangler.toml` must be real** (namespace ids are
   identifiers, not secrets — commit them). Create the namespaces once, either
   in the dashboard (Storage & Databases → KV) or locally with
   `npx wrangler kv namespace create P2_KV` (+ `--preview`), then replace the
   `REPLACE_WITH_…` placeholders.
2. **Secrets go in the dashboard**, not the repo: your Worker → Settings →
   Variables and Secrets (e.g. `IPFS_PIN_TOKEN`). Non-secret `[vars]` stay in
   `wrangler.toml`.

Pull requests get preview deployments automatically; the production branch
(usually `main`) deploys live.

### Point a domain at it (e.g. `p2present.com`)

Add your domain to Cloudflare, then uncomment the `routes` block in
[`wrangler.toml`](service/wrangler.toml) so the Worker serves `…/api/*` and
`…/p/*` on your domain, and set `APP_BASE` to where your static player lives
(GitHub Pages, Cloudflare Pages, etc.). Redeploy. Now `https://yourdomain/p/<id>`
links work end to end.

### Troubleshooting: Cloudflare + GitHub Pages DNS / SSL

Worker routes only fire on **proxied** (orange-cloud) hostnames — so if the
static player is GitHub Pages behind the same domain, the DNS records must be
proxied, and that changes how SSL works. The setup that works (and what
p2present.com runs):

- **Apex** → the four GitHub Pages A records (`185.199.108.153`–`111.153`),
  **proxied**. **`www`** → CNAME `<you>.github.io`, proxied too if you use it.
- **Cloudflare SSL/TLS mode: “Full”** — not “auto”/“Flexible” (redirect loops
  with Pages) and not “Full (strict)” (GitHub can’t provision a cert for your
  domain while proxied, so strict fails the origin handshake). Visitors get
  Cloudflare’s edge cert; Cloudflare→GitHub rides GitHub’s `*.github.io` cert.
- Turn on Cloudflare’s **“Always Use HTTPS”** — it replaces GitHub’s
  “Enforce HTTPS” checkbox, which never appears in this setup.
- **Expect GitHub Pages to warn** (`InvalidCNAMEError` / “improperly
  configured”): its DNS check sees Cloudflare’s IPs instead of its own. With
  the proxy on, that warning is **cosmetic** — the site serves fine.

If you *don’t* need Worker routes on the domain (e.g. the Worker lives on
`workers.dev` or its own subdomain like `api.<domain>`), the simpler setup is
grey-cloud (**DNS only**) records: GitHub then verifies the domain, provisions
its own Let’s Encrypt cert, and the “Enforce HTTPS” option appears.

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

## What `/p/:id` serves

A shared short link is more than a redirect: for a **known id** the Worker
returns a small HTML page whose Open Graph / Twitter tags carry the talk's own
title, author · event byline, and thumbnail (the manifest's absolute
`video.poster`, else the YouTube thumbnail, else the site's generic card) — so
pasting the link into X / Slack / Discord / LinkedIn previews *that talk*, not
the generic app card. Humans are redirected into the player instantly (meta
refresh + script + a visible link); crawlers, which don't run JS, read the
tags. Unknown, hidden, or expired ids fall back to a plain `302` so the player
surfaces its own error.

---

## Chapter proxy (`GET /api/chapters`)

The Builder's **✨ Auto-detect chapters** needs to read a YouTube video's
chapter list, which a static page can't do (the description is behind CORS).
The Worker proxies it:

```
GET <service>/api/chapters?u=<youtube url | 11-char id>
→ { "videoId": "…", "chapters": [{ "time": "1:24", "label": "The problem" }, …] }
```

It parses `M:SS Title` lines out of the video description (and the explicit
chapter markers where readable). Results are cached in KV for a day; cache
misses count against the same per-IP rate limit as writes.

**Set a `YT_API_KEY` secret to make this reliable.** YouTube walls off
anonymous datacenter traffic — from Workers egress the watch page answers
`429` and the innertube API returns empty challenge responses — so without a
key the endpoint usually can't reach the description at all. The official
[YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com)
works from anywhere on an ordinary API key (free quota: 10,000 units/day;
this endpoint spends 1 per lookup):

```bash
# console.cloud.google.com → enable "YouTube Data API v3" → Credentials → API key
cd service
npx wrangler secret put YT_API_KEY
```

With the key set it's used first; the scrape paths remain as fallbacks.

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
| `YT_API_KEY` *(secret)* | — | YouTube Data API v3 key — makes `/api/chapters` reliable (see above). |
| `IPFS_PIN_ENDPOINT` | Pinata `pinJSONToIPFS` | Pin API endpoint, if not Pinata. |

---

## <a id="make-permanent"></a>Wiring the "Make permanent" button (payment hooks)

The Host page's **arweave** provider offers pay-once **permanent** storage. When
the author supplies their own Arweave upload endpoint + credits, no payment is
needed — the file uploads directly. But to offer a **"Make permanent 💎"** button
that *charges* the author and funds the upload for them, you wire a **payment
hook**. p2present ships the boundary, not the keys (it is a static site — there
are **no secrets in the repo**).

The hook lives in [`docs/src/persist/payments.js`](docs/src/persist/payments.js).
Until configured, `makePermanent()` throws `PaymentNotConfiguredError`, which the
Host page surfaces as an actionable note (not a crash). To wire a real flow,
inject one or both adapters **before** the page scripts run:

```html
<!-- in docs/host/index.html <head>, before host.js -->
<script>
window.__P2_PAYMENTS = {
  // Fiat via Stripe — handled by YOUR server.
  async stripe({ file, onProgress }) {
    onProgress?.('Opening checkout…');
    const { url } = await fetch('/api/quote', {           // your endpoint
      method: 'POST', body: JSON.stringify({ bytes: file.size }),
    }).then((r) => r.json());
    // redirect to Stripe Checkout (or confirm a PaymentIntent); your webhook then
    // funds an Arweave/Irys upload and records a credit id.
    location.href = url;
    return { receipt: '<credit-id-from-your-server>' };
  },
  // On-chain rent — a wallet pays the storage node directly.
  async onchain({ file }) {
    const price = await irys.getPrice(file.size);          // your bundler SDK
    const tx = await irys.fund(price);                     // wallet signs
    return { receipt: tx.id };
  },
};
</script>
```

**Adapter contract.** Each adapter receives `{ provider, file, onProgress }` and
returns `{ receipt }` once the upload is funded. `makePermanent()` prefers
`onchain` when both are present (override per call with `method`). A wired
deployment continues from the receipt to the actual upload; the **TODO markers**
in `payments.js` (`TODO(payments)`) show exactly where each rail plugs in. Keep
all keys server-side / in the wallet — never in the committed site.

> The two concerns are independent: the **upload endpoint** (where bytes go) is
> the arweave provider's config; the **payment hook** (who pays) is
> `window.__P2_PAYMENTS`. Configure the endpoint for self-funded uploads, the
> hook for a paid button, or both.

---

## Tests

The handler logic is covered by unit tests against a Map-backed mock KV (no
network, no real Cloudflare):

```bash
cd service && npm test          # node --test "test/*.test.mjs"
```

The repository's top-level `npm test` runs these alongside the app's unit tests,
and `npm run smoke` exercises the **Save & share** + `?p=<id>` service-load paths
in headless Chrome against a mock service.
