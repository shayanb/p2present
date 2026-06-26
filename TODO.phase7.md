# Phase 7 — Pastebin-lite (community hosting backend)

Goal: a small **Cloudflare Worker + KV** service that hosts `p2present.json`
manifests behind short ids, wired into the app as a "Save & share" action and a
`?p=<id>` / `/p/<id>` player loader. Code-only — no deploy required this phase.

## Tasks
- [ ] `/service` Worker (`src/worker.js`, plain ESM JS):
  - [ ] `POST /api/p` → `{ id, editToken, url }` (create)
  - [ ] `GET  /api/p/:id` → manifest JSON (player fetches this)
  - [ ] `GET  /p/:id` → 302 → the player at `/app/?p=<id>` (human link)
  - [ ] `PUT  /api/p/:id` (Bearer edit token) → update
  - [ ] `DELETE /api/p/:id` (Bearer edit token) → delete
  - [ ] `POST /api/report` → record a report; auto-hide past a threshold
  - [ ] optional expiry (`?ttl=`/`?expiry=`, KV `expirationTtl`)
  - [ ] public / unlisted visibility
  - [ ] size cap (413) + per-IP rate limit (429)
  - [ ] edit tokens stored **hashed** (SHA-256) — never in plaintext
  - [ ] CORS (so GitHub-Pages app can fetch cross-origin)
- [ ] Optional IPFS mirror on save behind `IPFS_PIN=true` + `IPFS_PIN_TOKEN`
      secret (Pinata) — documented, never committed
- [ ] `service/wrangler.toml`, `service/package.json`, `.dev.vars.example`, `.gitignore`
- [ ] Worker handler tests (`service/test/worker.test.mjs`, `node:test` + mock KV)
- [ ] App client `docs/src/service.js` (configurable base URL; default placeholder)
- [ ] "Save & share" button in `/app/` → POST manifest → short `/p/<id>` link
- [ ] Player loads `?p=<id>` / `/p/<id>` via the service (bundled demo names reserved)
- [ ] `SERVICE.md` deploy guide + HOSTING/README updates (mark community backend)
- [ ] App-integration smoke (mock service in the smoke server)
- [ ] Verify: `npm test` (unit + worker) + `npm run smoke` — 390/780/1280, 0 real
      console errors, assets 200, static-only, light deps
- [ ] Commit + push each step; write `.phase7.done`; telegram summary

## Notes
- Service base URL precedence (app): `?service=` → `window.__P2_SERVICE_BASE` →
  `<meta name="p2present:service">` → `localStorage['p2present:service']` →
  default `https://p2present.com`.
- Edit tokens are kept in the author's browser (`localStorage['p2present:tokens']`)
  so they can update later; the server only stores the hash.
- The Worker is the **community-hosting backend**; self-hosters deploy their own
  and point their domain at it (see SERVICE.md).
