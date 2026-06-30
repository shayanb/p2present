# Crypto payments + registry — design (planned, not implemented)

> **Status: 🧭 design only.** This document specifies the **second** payments
> adapter — an on-chain, pay-once "rent" rail — and how it composes with the v3
> ENS CCIP-Read + EAS registry. **No on-chain code ships yet.** Nothing in
> `docs/` imports a wallet, a chain SDK, or a contract ABI today; the `onchain`
> hook in [`docs/src/persist/payments.js`](src/persist/payments.js) is still a
> stub. This is the blueprint for building it without breaking the
> non-negotiables (static-first, no deps in `docs/`, graceful degradation).

It mirrors the **Stripe rail** that *is* implemented (see
[SERVICE.md → Make permanent](../SERVICE.md#make-permanent)): same
`payments.js` boundary, same "a confirmed payment funds the same persistence
action", same eventual reflection of an `ar://` / `ipfs://` reference back into
the manifest. The only thing that changes is *who confirms the payment* — a
**chain + an indexer** instead of **Stripe + a webhook**.

---

## 1. Why a second rail

The Stripe rail is custodial fiat: the author pays p2present's operator, whose
Worker funds the upload. The on-chain rail removes that operator from the money
path entirely:

- The author's **wallet pays the storage network directly** (Irys/Turbo bundler,
  a Filecoin deal, or an escrow contract) — no operator float, no chargebacks.
- It is **permissionless**: anyone can self-host the (optional) indexer; with a
  pure bundler-funding model you need *no* server at all.
- The payment **receipt is itself portable proof** — a tx hash / data-item id
  that anchors to the same identity the v1.1 signature and the v3 EAS
  attestation use.

Both rails are **optional and degrade gracefully**: with neither configured the
"Make permanent 💎" button shows the documented "payment not configured" note,
and plain-URL / IPFS / WebTorrent manifests still play.

---

## 2. The adapter boundary (unchanged)

The on-chain rail is a drop-in `onchain` adapter behind the **existing**
`makePermanent()` contract. No new boundary is introduced.

```
makePermanent({ provider, file, method, onProgress, adapters })
  → prefers adapters.onchain when present (override with method:'onchain'|'stripe')
  → adapter({ provider, file, onProgress }) resolves { receipt }
  → makePermanent returns { receipt, method:'onchain' }
```

```js
// Shape the planned default on-chain adapter will satisfy (mirrors
// defaultStripeAdapter). Injected via window.__P2_PAYMENTS.onchain, or
// synthesized from an `<meta name="p2present:onchain" content="...config">`.
//
// type OnchainAdapter = (args: {
//   provider: 'arweave'|'pinning'|'seedbox'|'s3',
//   file: File,
//   onProgress?: (msg: string) => void,
// }) => Promise<{
//   receipt: string,          // tx hash or bundler data-item id
//   chainId: number,
//   token: string,            // 'ETH' | 'USDC' | 'AR' | 'FIL' | …
//   ref?: string,             // ar://… if the adapter uploaded inline
//   scheme?: 'ar'|'ipfs'|'magnet'|'https',
// }>;
```

Two facts make this fit cleanly:

1. `makePermanent()` already **prefers `onchain`** when both rails are present,
   so wiring the wallet path is purely additive.
2. The Stripe adapter **redirects and is resumed** by
   `resumePendingPermanent()`. The on-chain adapter instead **stays on the page**
   (the wallet popup is modal), so it can return `{ receipt, ref }` directly —
   no redirect/resume dance. The host UI treats both the same: a `{ ref, scheme }`
   to add to the "Hosted references" → Builder handoff.

---

## 3. Wallet connect (no deps in `docs/`)

Same rule as pdf.js / WebTorrent: **lazy-load from CDN only when invoked**.

- **EIP-1193 first.** If `window.ethereum` exists (MetaMask, Rabby, Coinbase,
  Frame), use it directly — `eth_requestAccounts`, `eth_chainId`,
  `wallet_switchEthereumChain`, `eth_sendTransaction`, `personal_sign`. Zero
  bundle.
- **WalletConnect fallback** for mobile / no-extension: dynamic
  `import('https://esm.sh/@walletconnect/ethereum-provider')` *at click time*.
- **Solana / Arweave wallets** (Phantom, ArConnect) behind the same lazy pattern
  if/when those chains are enabled.

A thin `wallet.js` (planned, in `docs/src/persist/onchain/`) wraps provider
discovery + `chainId` switching and exposes `connect() → { address, chainId,
request }`. It holds **no keys** — signing always happens in the wallet.

```
docs/src/persist/onchain/           ← planned module dir
  wallet.js        EIP-1193 / WalletConnect discovery + chain switching
  quote.js         bytes → price per (chain, token), via the bundler's price API
  irys.js          fund an Irys/Turbo node from the connected wallet → data-item
  escrow.js        (optional) pay an escrow/registry contract; emit PaymentConfirmed
  index.js         buildOnchainAdapter(config) → OnchainAdapter
```

---

## 4. Supported chains + tokens

Chosen for: (a) a real pay-once permanence story, (b) cheap finality, (c)
stablecoin UX. Start narrow, expand behind config.

| Network | Token(s) | Role | Maps to |
|---|---|---|---|
| **Irys / Turbo (multi-chain)** | ETH, MATIC, USDC, SOL, AR | Fund a bundler that writes to **Arweave** | `ar://<txid>` (pay-once permanent) |
| **Base / Optimism / Arbitrum** (L2) | ETH, **USDC** | Cheap escrow payment → indexer funds persistence | `ar://` or `ipfs://` |
| **Ethereum L1** | ETH, USDC | Escrow + EAS attestations (registry anchor) | identity / vouch |
| **Filecoin (FVM)** | FIL, USDFC | Storage **deals** (deal-based, cold) | `ipfs://` + deal id |

Defaults: **Irys-funded Arweave** for the permanent default (mirrors the
`arweave` provider), **USDC on an L2** for the low-fee stablecoin path. The
`pinning` (IPFS) and `seedbox` (WebTorrent) providers map to a subscription/escrow
model rather than pay-once — the adapter quotes a term and the indexer renews.

Price discovery is **read-only and client-side**: `quote.js` asks the bundler's
price endpoint (e.g. Irys `/price/<bytes>`) or an escrow contract `view` for the
amount, in the selected token, before the wallet ever opens.

---

## 5. How a confirmed on-chain payment funds persistence

This is the crux: **make the chain event the analogue of the Stripe webhook.**
Two models, pick per provider; both end at the same control-API call the Stripe
webhook already makes (`POST {PERSIST_CONTROL_URL}/jobs`).

### Model A — Direct bundler funding (no server, default for `arweave`)

The wallet funds the bundler and uploads in the same session. There is **no
webhook** because there is **no escrow** — the data-item receipt *is* the proof.

```
Author clicks "Make permanent 💎"  (onchain rail, provider=arweave)
  1. quote.js:   price = GET <bundler>/price/<bytes>            (read-only)
  2. wallet.js:  connect() → { address, chainId, request }
  3. irys.js:    fund(price)  → wallet signs a transfer to the bundler
  4. irys.js:    upload(file) → bundler returns { id }          (data-item id)
  5. adapter returns { receipt:id, ref:`ar://${id}`, scheme:'ar' }
  6. host UI reflects ar://<id> into Hosted references → Builder
```

No `PERSIST_CONTROL_URL`, no indexer — fully static + permissionless. This is the
on-chain mirror of "the author supplies their own Arweave endpoint", except the
funding is a wallet tx instead of a Bearer token.

### Model B — Escrow contract + indexer (for IPFS pin / seedbox / deals)

When persistence is a *service* the operator runs (pinning, seeding, Filecoin
deals), payment is an escrow the operator can claim, and an **indexer** plays the
webhook's role.

```
                          on-chain                         off-chain (operator)
Author ──pay──▶ Escrow/Registry contract ──emit──▶  Indexer (watches logs)
   │            PaymentConfirmed(jobId,                 │
   │              payer, amount, token, ref?)           │  POST {CONTROL_URL}/jobs
   │                                                    ▼   { jobId, provider, bytes }
   └─ adapter returns { receipt: txHash } ───────▶  Control API funds pin/seed/deal
                                                        │  → ar:// / ipfs:// / magnet:
   host UI polls  <indexer>/result?jobId=  ◀───────────┘     (recorded against jobId)
```

- The **Stripe webhook and the indexer call the identical control-API endpoint.**
  The deploy/ control API (Part 3) does not care which rail paid — it persists a
  `jobId` and returns a ref. One backend, two funding sources.
- The indexer is the **only** new server, and it is optional: a fork can run
  Model A only and keep zero servers.
- **Idempotency** mirrors the webhook: key on `(chainId, txHash, logIndex)` the
  way the Stripe path keys on `event.id`.

### Mapping table (so both rails converge)

| Concern | Stripe rail (built) | On-chain rail (planned) |
|---|---|---|
| Price | Worker `priceCents(bytes)` | `quote.js` bundler/escrow `view` |
| Authorise payment | Checkout Session | wallet tx (transfer / escrow deposit) |
| "Payment confirmed" signal | signed webhook → `checkout.session.completed` | bundler receipt (A) / `PaymentConfirmed` log (B) |
| Trigger persistence | `POST {CONTROL_URL}/jobs` | same call (B) / inline upload (A) |
| Idempotency key | `event.id` | `txHash:logIndex` |
| Reflect ref to manifest | poll `/api/pay/result` | adapter return (A) / poll `<indexer>/result` (B) |

---

## 6. Tie-in to the v3 registry (ENS CCIP-Read + EAS)

The on-chain rail and the registry share one **identity**: the key that signs
v1.1 manifests.

### 6a. Signing key → registry identity

- v1.1 signs the canonical manifest bytes with an EIP-191 (secp256k1) or Ed25519
  key; the player already recovers + badges the signer address
  (`docs/src/sign.js`, `docs/src/crypto/`).
- In v3 that **same address** is the registry identity. An ENS name (e.g.
  `talks.alice.eth`) sets a text record / resolver pointing at the address, so
  `signer == resolve(ensName)` upgrades the badge from "✓ signed by 0x…" to
  "✓ talks.alice.eth".
- **CCIP-Read (ERC-3668)**: the ENS resolver answers off-chain (gasless). The
  player does a normal `eth_call`; on an `OffchainLookup` revert it fetches the
  gateway URL and verifies the returned signature against the resolver — no tx,
  no gas. This is read-only and lazy-loaded, so it stays inside the static-site
  rules.

```
Player resolves a manifest's claimed name:
  ensName ──namehash──▶ Resolver.resolve()  ──OffchainLookup revert──▶ gateway URL
  gateway returns { result, sig } ──▶ Resolver.resolveWithProof() verifies
  → catalog: ipfs://… of this speaker's talks; identity address for badge match
```

### 6b. EAS attestation vouches a manifest

- An **EAS** (Ethereum Attestation Service) attestation binds a **manifest hash**
  to an **identity**: schema roughly
  `attest(manifestHash: bytes32, ref: string, signer: address)`.
- Verification chain the player can show:
  `signature valid` → `signer == ENS identity` → `EAS attestation(manifestHash)
  exists & not revoked & issued by that identity` ⇒ **"published by
  talks.alice.eth"** with the strongest badge. Each link degrades independently
  (no ENS → address badge; no EAS → "signed but unattested").
- **Where payment meets attestation:** when the on-chain rail uses Model B, the
  escrow's `PaymentConfirmed` can carry the `manifestHash`, and the indexer (or
  the operator) can **co-issue the EAS attestation as part of fulfilment** — so
  "made permanent" and "vouched in the registry" are one flow. The data-item id
  / tx hash from §5 is recorded *in* the attestation as provenance.

```
On-chain "make permanent + vouch" (Model B, v3):
  pay escrow(jobId, manifestHash) ─▶ PaymentConfirmed log
     ├─▶ indexer funds persistence  → ar://… / ipfs://…
     └─▶ indexer EAS.attest({ manifestHash, ref, signer }) (revocable)
  player later: verify sig → match ENS → check EAS(manifestHash) ⇒ trusted badge
```

---

## 7. Interfaces (planned)

```js
// docs/src/persist/onchain/index.js  (planned)
export function buildOnchainAdapter(config) { /* → OnchainAdapter (see §2) */ }

// docs/src/persist/onchain/wallet.js
export async function connect() {
  // returns { address, chainId, request(method, params) }; lazy WalletConnect
}
export async function ensureChain(request, chainId) { /* wallet_switchEthereumChain */ }

// docs/src/persist/onchain/quote.js
export async function quote({ bundler, bytes, token, chainId }) {
  // → { amount, token, decimals, to }   (read-only price discovery)
}

// docs/src/persist/onchain/irys.js   (Model A)
export async function fundAndUpload({ request, bundler, file, onProgress }) {
  // → { id /* data-item */, ref:`ar://${id}` }
}

// docs/src/persist/onchain/escrow.js  (Model B)
export async function payEscrow({ request, escrow, jobId, manifestHash, amount, token }) {
  // → { txHash }  (PaymentConfirmed emitted on-chain; indexer fulfils)
}
```

Indexer (optional, lives **outside** `docs/` — alongside the deploy/ control API):

```
GET  /result?jobId=        → { status, ref?, scheme?, txHash }   (poll target)
event watcher: on PaymentConfirmed(jobId, payer, amount, token, manifestHash)
  → POST {CONTROL_URL}/jobs { jobId, provider, bytes }      (same as Stripe webhook)
  → optionally EAS.attest({ manifestHash, ref, signer })
  → idempotency key: `${chainId}:${txHash}:${logIndex}`
```

A minimal escrow contract sketch (Solidity, **not written yet**):

```solidity
// PaymentRegistry — pay once, emit a claimable confirmation. Illustrative only.
event PaymentConfirmed(bytes32 indexed jobId, address indexed payer,
                       address token, uint256 amount, bytes32 manifestHash);

function pay(bytes32 jobId, bytes32 manifestHash, address token, uint256 amount) external {
    // pull `amount` of `token` (or msg.value) into escrow for the operator,
    // then: emit PaymentConfirmed(jobId, msg.sender, token, amount, manifestHash);
}
```

---

## 8. Security + invariants

- **No keys, no ABIs committed to `docs/`.** Contract addresses + chain config
  arrive via `<meta>`/`window.__P2_PAYMENTS` config, exactly like the payments
  base URL — never hard-coded secrets. Wallet keys never leave the wallet.
- **Read-before-pay.** Price + chain are quoted read-only; the wallet popup shows
  the user the exact token + amount; no blind signing.
- **Trust is verifiable, not asserted.** A badge upgrade requires sig → ENS → EAS
  to *all* check out client-side; any missing link downgrades gracefully.
- **Replay-safe.** Per-tx idempotency keys mirror the Stripe `event.id` guard.
- **Static-first preserved.** Model A needs no server; Model B's indexer is
  optional and external. The player itself only ever does read-only,
  lazy-loaded calls for badges.

---

## 9. Build order (when this is picked up)

1. `wallet.js` + `quote.js` (read-only) — connect, switch chain, quote a price.
2. `irys.js` Model A end-to-end → `onchain` adapter returns `ar://` (zero-server).
3. Wire `buildOnchainAdapter()` into `configuredPayments()` next to the Stripe
   default; `makePermanent()` already prefers it.
4. Escrow contract + indexer (Model B) for pin/seed/deal providers; reuse the
   deploy/ control API.
5. v3: ENS CCIP-Read resolver + EAS schema; upgrade the player's signer badge to
   match identity + attestation.

Until step 1 lands, `payments.js` keeps throwing `PaymentNotConfiguredError` for
the on-chain path — **planned, not implemented.**
