# p2present roadmap 🗺️

p2present is **open core**. The format, the player, the Builder, the Host helper,
and self-hosting are free and MIT-licensed — and always will be. The items below
are the *optional* services layered on top, built around a single principle:

> **Open core, free forever. You pay only to keep a talk alive beyond your own
> machine, or to verify its identity — never to use the player or the format.**

Each phase is additive and degrades gracefully: if a hosted service is gone, a
manifest with plain URLs / IPFS / WebTorrent sources still plays.

---

## ✅ Shipped (today)

The static player + format are done and in production:

- Synced bidirectional playback (scrub video → deck follows, and vice-versa).
- Any video source — **YouTube · MP4 · IPFS · WebTorrent** — with ordered fallback.
- **HTML / PDF / embed** decks.
- Subtitles (VTT/SRT), layout modes, fullscreen, deep-links + a share menu.
- **Visual Builder** (schema-validated `p2present.json`) and an in-browser **Host helper**.
- **Community manifest hosting** ([Save & share](SERVICE.md) pastebin service) — *v1, shipped.*
- **Signed manifests** (EIP-191 / Ed25519, verified + badged in the player) — *v1.1, shipped.*
- **Pluggable persistence providers** (Arweave `ar://` default · IPFS pinning · WebTorrent seedbox · S3) with a stubbed "Make permanent" payment hook — *v2 layer, shipped; paid rail pending.*
- 100% static — fork it, drop content in `docs/content/`, enable GitHub Pages.

See [README](README.md) and [SPEC.md](SPEC.md) for the manifest format.

---

## v1 — Community manifest hosting (pastebin) · *✅ shipped*

A free place to publish a manifest when you don't want to run a server at all.

- Paste a `p2present.json` → get back a short, shareable link.
- One-click **"publish manifest"** from the Builder.
- Free tier, no account required.
- Assets stay wherever you put them (URL / IPFS / WebTorrent); only the small
  manifest is hosted.

**Why:** the lowest-friction way to share a talk page — nothing to deploy.

---

## v1.1 — Signed manifests · *✅ shipped*

Make a published manifest tamper-evident before any registry exists.

- Detached signatures over the canonical manifest bytes.
- The player can show a "signed by …" indicator and warn on mismatch.
- Works with plain keys today; forward-compatible with the v3 registry identities.

**Why:** integrity without trusting the host — the bytes you signed are the bytes
that play.

---

## v2 — Paid persistence (pluggable) · *layer shipped; paid rail pending*

Keep a talk online for good without seeding it from your laptop. The persistence
layer is a **pluggable provider interface** (`docs/src/persist/`, mirroring the
video providers) chosen per upload — **shipped in Phase 9**:

| Provider | Model | Status |
|---|---|---|
| `arweave` *(default)* | **pay-once** | ✅ `ar://` via a user-funded upload endpoint; pay-once rail stubbed |
| `pinning` | subscription | ✅ Managed IPFS pinning (Pinata / web3.storage) → `ipfs://` |
| `seedbox` | subscription | ✅ WebTorrent seed (in-tab + optional always-on) → `magnet:` |
| `s3` | pay-as-you-go | ✅ Plain object storage / presigned PUT → `https` |
| `filecoin` | deal-based | ⏳ Cold, verifiable storage deals (register a new provider) |

- The Host page builds its UI from the registry; each provider turns a file into
  a reference, with tokens kept only in the browser.
- **Shipped since:** the **Stripe "Make permanent" rail** is now real — a sibling
  Cloudflare Worker (`service/src/payments-worker.js`) creates a Checkout Session,
  verifies the webhook, and funds the actual persistence via the
  [`deploy/`](deploy/README.md) control API; the client reflects the resulting
  `ar://` / `ipfs://` reference back into the manifest. Ships no keys (Worker
  secrets). See [SERVICE.md → Make permanent](SERVICE.md#make-permanent).
- **Still pending:** the **on-chain "rent" rail** (the second `payments.js`
  adapter) is designed but not implemented — wallet-funded, permissionless
  permanence mirroring the Stripe boundary. Design in
  [docs/CRYPTO-PAYMENTS.md](docs/CRYPTO-PAYMENTS.md).

**Why:** this is the one thing you genuinely *can't* get for free — durable hosting
when your machine is offline. Pay only for what persists.

---

## v3 — ENS CCIP-Read registry + EAS verification · *roadmap*

Human-readable, verifiable identities for talks and speakers.

- **ENS names** like `talks.you.eth` resolve to a speaker's catalog of talks.
- **Gasless resolution via CCIP-Read**: lookups are served offchain (ERC-3668),
  so resolving a name costs no gas and no transaction.
- **EAS attestations** vouch that a given manifest is authentic / published by
  that identity — composable, revocable, onchain-anchored trust.
- Ties back to **v1.1 signed manifests**: the signature key maps to the registry
  identity.

**Why:** so a shared link can *prove* who published it — "this really is that
speaker's talk" — without a central authority.

The registry composes with the on-chain payment rail (a confirmed payment can
co-issue the EAS attestation that vouches the manifest) — see the design in
[docs/CRYPTO-PAYMENTS.md → Tie-in to the v3 registry](docs/CRYPTO-PAYMENTS.md).

---

## Principles

- **Static-first.** The player never requires a backend; services are optional.
- **Graceful degradation.** Remove any hosted piece and plain-URL/p2p manifests still play.
- **No lock-in.** Pluggable persistence; portable, signed, self-describing manifests.
- **Pay for persistence & proof, not for software.** Open core, free forever.
