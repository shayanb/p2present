# p2present — Phase 9 build checklist (Persistence providers + payment hooks)

Resumable. On each relaunch: `git log --oneline -20`, read this file, continue.
Commit + push to `main` after each meaningful step (Pages auto-redeploys).

## Goal
Generalize "host your assets" into a pluggable **persistence-provider** interface
that mirrors the video-provider pattern (Registry + a base class + one module per
provider). A provider turns a `File` into a manifest **reference**:

| provider           | scheme    | model                         |
|--------------------|-----------|-------------------------------|
| `arweave` (DEFAULT)| `ar://`   | pay-once permanence           |
| `pinning`          | `ipfs://` | Pinata / web3.storage (rent)  |
| `seedbox`          | `magnet:` | in-tab + always-on seed       |
| `s3`               | `https`   | S3 / presigned PUT endpoint   |

Each `put(file) -> { ref, scheme, gateway? }`. User-supplied tokens live ONLY in
the UI / localStorage, never committed. Host helper picks a provider, uploads,
hands the reference to the Builder (existing `p2present:hosted` localStorage list).

Payment hooks for "Make it permanent" are **STUBBED** (no live keys): a clear
`payments.js` adapter boundary documenting how to wire Stripe (fiat) or an
on-chain rent path. No secrets in the repo.

## Tasks
- [ ] `docs/src/persist/base.js` — `BasePersistenceProvider` (static descriptor + `put()`)
- [ ] `docs/src/persist/index.js` — `persistProviders` Registry + interface contract
- [ ] `docs/src/persist/arweave.js` — ar:// (permanent; routes through payment hook when no endpoint)
- [ ] `docs/src/persist/pinning.js` — ipfs:// (Pinata JWT / web3.storage token)
- [ ] `docs/src/persist/seedbox.js` — magnet: (in-tab WebTorrent + optional always-on seedbox POST)
- [ ] `docs/src/persist/s3.js` — https (presigned / PUT endpoint)
- [ ] `docs/src/persist/payments.js` — STUBBED Stripe + on-chain rent adapters + TODO boundary
- [ ] resolve.js: `ar://` recogniser + gateway URL; httpCandidates + manifest resolveSrc/deck wired
- [ ] Host UI (`docs/host/`): provider picker + dynamic fields + upload + "Make permanent" + seedbox stop
- [ ] Tests: provider interface with mock uploads (each scheme) + payment stub throws documented error
- [ ] Smoke: host loads, provider switch, pinning pin (mock), arweave payment stub, seedbox UI, 390/780/1280
- [ ] Docs: HOSTING + SERVICE (Stripe/crypto wiring) + SPEC + README + ROADMAP
- [ ] DONE gate: commit+push each step, write .phase9.done, telegram summary+URL

## Progress log
- (init) Read full codebase + video-provider/host patterns. Designed provider table above.
  telegram via `openclaw message send --channel telegram --target '-5269558152'`.
</content>
</invoke>
