# AGENTS.md — p2present

Entry point for an AI coding agent (or new human) picking up this repo. Read this
first, then the doc it points you to for the area you're touching. If anything
here drifts from the code, the code wins — update this file.

## What this is (in one breath)

p2present is a **forkable, dependency-light, 100% static web app** that plays
presentation **slides in sync with the talk video** (scrub the video → the deck
follows, and vice-versa). One repo, two faces: a **resolver/player** that loads a
`p2present.json` manifest from anywhere (`https`, `ar://`, `ipfs://`, `magnet:`),
and a **forkable self-host template** (drop content in `docs/content/`, enable
GitHub Pages). Live: https://ibeezhan.github.io/p2present/ · player at `/app/`.

## Philosophy — the non-negotiables

These are load-bearing. Don't violate them without an explicit decision from Shayan.

1. **Static-first. No server runtime in the core.** Everything in `docs/` must
   run as plain files served by GitHub Pages. No bundler, no build step, no
   framework. The only backend (`service/`) is an *optional* Cloudflare Worker for
   the "Save & share" pastebin — the app must fully work without it.
2. **Open core, free forever.** The player, format, Builder, Host helper, and
   self-hosting are MIT and always free. You pay only to *persist* a talk beyond
   your own machine or to *verify* its identity — never to use the software.
3. **Graceful degradation.** Remove any hosted piece and a manifest with plain
   URLs / IPFS / WebTorrent sources still plays. Optional services degrade, never
   break.
4. **No lock-in.** Portable, signed, self-describing manifests. Pluggable
   providers (video transports *and* persistence) behind uniform interfaces.
5. **Vanilla ESM, no dependencies in the shipped app.** Native browser modules,
   web components, dynamic `import()`. Third-party libs (pdf.js, WebTorrent) are
   loaded lazily from CDN only when a manifest needs them. Keep it tiny.
6. **Accessibility + reduced-motion are requirements, not polish.** Every
   animated/interactive feature needs keyboard + aria support and a sane
   `prefers-reduced-motion` fallback. The smoke test enforces this.

## Layout

```
docs/                     ← the entire static app (this is what Pages serves)
  index.html  home.js  home.css      landing / resolver page
  app/index.html                     the player app shell
  host/                              Host helper (upload via persistence provider)
  builder/                          Visual manifest builder (referenced; in docs/)
  content/{demo,moav-pdf}/          bundled demo presentations
  p2present.schema.json             draft-07 JSON Schema for the manifest
  src/
    main.js player.js sync.js       core: bootstrap, player, slide↔video sync
    manifest.js resolve.js          load + validate + resolve a manifest/sources
    registry.js schema-validate.js  provider registry + validation
    sign.js time.js subtitles.js    signatures, time model, VTT/SRT
    service.js                      client for the optional Save & share worker
    video/    {youtube,mp4,ipfs,webtorrent}.js + base.js + index.js
    decks/    {html,pdf,embed}-deck.js + base.js + index.js
    transitions/ {cut,fade,slide,none}.js + index.js
    persist/  {arweave,pinning,seedbox,s3}.js + payments.js + base.js + index.js
    crypto/   secp256k1 keccak ens base64url   (for EIP-191 verify + ENS names)
service/                  ← OPTIONAL Cloudflare Worker + KV (Save & share). Not core.
scripts/  test.mjs  smoke.mjs  import-chapters.mjs
*.md      README SPEC ROADMAP AUTHORING HOSTING SERVICE DOCS
```

**Adding a provider** = drop a module in `video/`, `decks/`, or `persist/`
implementing the `base.js` interface and register it in that folder's `index.js`
(and for persistence, the Host UI builds itself from the registry). This is the
intended extension pattern — mirror an existing sibling.

## Build / test / run

No build step. Node ≥ 18 for the test scripts (uses the native test runner).

```bash
npm run dev      # serve docs/ at http://localhost:5173 (npx serve)
npm test         # unit: scripts/test.mjs  + service worker tests
npm run smoke    # headless-Chrome (Playwright) E2E + screenshots at 390/780/1280
```

`npm run smoke` is the real gate: it drives the live app, asserts **0 real console
errors**, all assets 200, static-only behavior, provider fallback, p2p routing,
deep-links, builder + host flows, PDF luminance (no blank slides), and
`prefers-reduced-motion`. **Run it before claiming any UI change works**, and
verify visible changes on the live demo URL too.

## Conventions

- Commits: short imperative subject, Conventional-Commits-ish (`feat(phaseN): …`,
  `fix: …`, `chore: …`). Work has historically been organized in **phases**;
  that per-phase history lives in `git log` (the old `TODO.phaseN.md` /
  `.phaseN.done` scaffolding has been retired — see the Status section below for
  the current summary).
- Style: vanilla ESM, no TS, no transpile. Match the surrounding file's idiom.
- Never introduce a runtime dependency into `docs/`. CDN-lazy-load if unavoidable.
- Keep `SPEC.md` and `docs/p2present.schema.json` in lockstep when the manifest
  format changes.

## Status (as of 2026-06-27, main @ recent)

**Done (Phases 2→13):** synced bidirectional player; YouTube/MP4/IPFS/WebTorrent
sources with ordered fallback; HTML/PDF/embed decks; subtitles; layout modes;
fullscreen overlay controls; deep-links + share menu (incl. export manifest JSON);
**Visual Builder**; **Host helper**; **Save & share** pastebin (Worker, v1);
**signed manifests** (EIP-191/Ed25519 verified + badged, v1.1); **pluggable
persistence layer** (Arweave/IPFS-pinning/seedbox/S3, v2 layer); Phase 13 app-UX
polish (paused-seek YouTube slider, centered START overlay, unfolding layout
button, sources→player animation) + a header-UX refinement on top.

**Open / next (see ROADMAP.md):**
1. **v2 paid rail (the main remaining engineering chunk).** The persistence
   *providers* work, but the **"Make permanent" payment hook** is stubbed —
   `docs/src/persist/payments.js` defines the Stripe (fiat) + on-chain-rent adapter
   boundary but ships no keys. Wiring a live charge → fund-an-Arweave-upload flow
   is the work. See `SERVICE.md → Make permanent`.
2. **`filecoin` persistence provider** — register a new provider for cold,
   verifiable storage deals.
3. **v3 registry** — ENS CCIP-Read (ERC-3668 gasless resolution) + EAS
   attestations so a shared link can *prove* who published it; ties back to the
   v1.1 signing key. Roadmap only, nothing started.

## Where to read next

- Format / manifest fields → **SPEC.md** (+ `docs/p2present.schema.json`)
- Make a presentation → **AUTHORING.md**
- Asset hosting / persistence providers → **HOSTING.md**
- The optional Worker + payment hook → **SERVICE.md**
- Vision / what's free vs paid / what's next → **ROADMAP.md**
- One-page index of all docs → **DOCS.md**
- Phase history + acceptance criteria → `git log` (commits are tagged `feat(phaseN): …`)
