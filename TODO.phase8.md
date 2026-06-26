# p2present — Phase 8 build checklist (Signed manifests)

Resumable. On each relaunch: `git log --oneline -20`, read this file, continue.
Commit + push to `main` after each meaningful step (Pages auto-redeploys).

## Goal
Sign a `p2present.json` with an author key (raw Ed25519 keypair OR an Ethereum
wallet / EIP-191 `personal_sign`); store signature + signer in a `sig` block
without breaking schema validation; the player verifies on load and shows a
"✓ signed by <ENS/domain/0x…>" badge (subtle "unsigned" otherwise), never
blocking playback. ENS reverse-resolve for display, read-only, graceful fallback.

## Signing scheme (design)
- Canonical JSON = JCS-lite: recursively sort object keys, minimal separators,
  UTF-8 (`docs/src/sign.js::canonicalize`). One impl shared by signer + verifier
  + Node tests so bytes match everywhere.
- Signed payload = the whole manifest **including** `sig.alg/signer/canon` but
  with `sig.signature` removed. So the signer claim is itself covered by the sig
  (tampering the claimed address/key breaks verification).
- `sig` block:
  - `alg`: `"eip191"` | `"ed25519"`
  - `signer`: eip191 → `{address}`; ed25519 → `{key, domain?}`
  - `signature`: eip191 → `0x`+r(32)+s(32)+v(1); ed25519 → base64url(64)
  - `canon`: `"p2/jcs-1"`
- eip191: hash = keccak256("\x19Ethereum Signed Message:\n"+len+canon); ecrecover
  the address; valid iff recovered === signer.address. Trust anchor = the address.
- ed25519: WebCrypto verify(canonBytes) against signer.key (raw 32-byte pubkey).

## Tasks
- [x] crypto/keccak.js (keccak-256, BigInt lanes) — vector-checked (empty/abc/hello)
- [x] crypto/secp256k1.js (sign + recoverAddress + address-from-pubkey) — privkey=1 + web3 key vectors; Node-interop recover confirmed
- [x] sign.js: canonicalize, signEip191WithKey/Wallet, signEd25519, verifyManifest, describeSigner; crypto/ens.js reverseEns (forward-confirmed)
- [x] schema: optional `sig` block; SPEC.md top-level row + "Signing" section; manifest carries raw.sig
- [x] Builder: 🔏 Sign card (wallet personal_sign / paste ETH key / generate Ed25519) → embeds sig; stale-on-edit warning; remove
- [x] Player: verify _raw on load → header badge (✓ signed by ENS/0x…), subtle unsigned/invalid; never blocks; ENS upgrade gated by window.__P2_ENS
- [x] Tests: 35/35 — keccak/secp vectors, canonicalize stable, eip191+ed25519 round-trip, tamper (content+signer), unsigned ok, schema accepts sig
- [x] Smoke: 99/99 — valid badge, tampered→invalid (still plays), unsigned pill, builder sign+stale; signed-badge.png; 390/780/1280, 0 real console errors
- [x] Docs: README + AUTHORING + DOCS + SPEC; schema in sync
- [x] DONE gate: commit+push each step, write .phase8.done, telegram summary+URL

## Progress log
- (init) Read full codebase. Designed sig scheme above. No telegram/secrets in repo;
  telegram via `openclaw message send --channel telegram --target '-5269558152'`.
- Built dependency-free crypto (keccak256 + secp256k1, vector + Node-interop verified) → sign.js
  (canonical JSON, EIP-191 + Ed25519, verify, ENS) → schema/SPEC/manifest passthrough → player
  badge → builder Sign card → 35 unit + 99 smoke green. Committed + pushed each step.
</content>
</invoke>
