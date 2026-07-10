# p2present manifest specification — `p2present.json` v1.0

A presentation in p2present is described by a single JSON manifest. This document
is the canonical reference for the **v1.0** schema. A machine-readable JSON Schema
lives at [`docs/p2present.schema.json`](docs/p2present.schema.json).

Every source in a manifest — the manifest itself, the video, the deck, and
assets — may be a plain **`https`** URL, an **`ar://`** Arweave tx, an
**`ipfs://`** CID, or a **`magnet:`** link. See [Source transports](#source-transports) and
[Loading & sharing](#loading--sharing-query-args--base64).

---

## Quick example

```json
{
  "p2present": "1.0",
  "title": "My Talk",
  "meta": { "author": "Ada Lovelace", "event": "Confoo 2026", "date": "2026-03-01", "description": "…" },
  "video": {
    "sources": [
      { "provider": "youtube", "src": "uYygWN1MZDE" },
      { "provider": "mp4", "src": "video/talk.mp4" }
    ],
    "poster": "video/poster.jpg"
  },
  "deck": {
    "type": "html",
    "sources": [ { "src": "slides/index.html" } ],
    "slideCount": 23
  },
  "timing": [
    { "time": 0.0,  "slide": 1, "transition": "cut"  },
    { "time": 12.5, "slide": 2, "transition": "fade" }
  ],
  "subtitles": [
    { "lang": "en", "label": "English", "src": "subs/en.vtt", "format": "vtt", "default": true },
    { "lang": "fa", "label": "فارسی",   "src": "subs/fa.srt", "format": "srt" }
  ],
  "resolvers": {
    "ipfsGateways": ["https://{cid}.ipfs.dweb.link", "https://ipfs.io/ipfs/{cid}"],
    "webtorrentTrackers": ["wss://tracker.openwebtorrent.com"]
  },
  "layout": { "split": 0.6, "mode": "split", "transition": "fade" }
}
```

---

## Top-level fields

| Field        | Type             | Required | Notes |
|--------------|------------------|:--------:|-------|
| `p2present`  | string           |    no    | Schema version. Use `"1.0"`. |
| `title`      | string           |    no    | Shown in the header and as the document title. Defaults to `"Untitled presentation"`. |
| `meta`       | object           |    no    | Descriptive metadata — see [meta](#meta). |
| `video`      | object           |  **yes** | The talk video — see [video](#video). |
| `deck`       | object           |  **yes** | The slide deck — see [deck](#deck). |
| `timing`     | array \| string  |    no    | Slide-boundary cues, inline or external — see [timing](#timing). |
| `subtitles`  | array            |    no    | Caption tracks — see [subtitles](#subtitles). |
| `resolvers`  | object           |    no    | Phase-2 network overrides — see [resolvers](#resolvers). |
| `layout`     | object           |    no    | Default layout — see [layout](#layout). |
| `sig`        | object           |    no    | Author signature — see [sig](#sig). Verified on load; never blocks playback. |

> **Path resolution.** Every relative `src` (deck, mp4 video, subtitles, poster,
> external timing file) is resolved against the **manifest's own URL**, so a
> manifest hosted anywhere resolves its sibling assets correctly. Bare tokens
> that aren't paths (a YouTube id, a magnet, a CID) are left verbatim.

---

### meta

Free-form descriptive metadata. All keys optional.

```json
"meta": { "author": "", "event": "", "date": "", "description": "" }
```

---

### video

The talk video. `sources` is an **ordered fallback list**: the player tries each
source in order and uses the **first that loads**. This lets you offer a hosted
fallback behind a peer-to-peer primary, etc.

```json
"video": {
  "sources": [
    { "provider": "youtube", "src": "uYygWN1MZDE" },
    { "provider": "mp4",     "src": "https://cdn.example/talk.mp4" }
  ],
  "poster": "poster.jpg"
}
```

| Provider     | Status         | `src` |
|--------------|----------------|-------|
| `youtube`    | ✅ implemented  | video id, or a `watch?v=` / `youtu.be` / `embed` URL |
| `mp4`        | ✅ implemented  | URL to any browser-playable file (resolved if relative) |
| `webtorrent` | ✅ implemented  | `magnet:?xt=…` — streamed into `<video>` via `file.renderTo()` using `resolvers.webtorrentTrackers` |
| `ipfs`       | ✅ implemented  | CID or `ipfs://…` — played through the first reachable `resolvers.ipfsGateways` gateway |

- `video.poster` *(optional)* — poster image URL, used by the `<video>`-backed providers.
- Because `sources` is a fallback list, a manifest can list `webtorrent` **first**
  and `mp4` second: the player streams from the swarm when peers are available and
  **gracefully falls through** to the hosted mp4 if the torrent can't be reached
  (no peers, blocked WSS, timeout). The same applies to `ipfs` → `mp4`.

---

### deck

The slide deck. `sources` is likewise an **ordered fallback list** of URLs.

```json
"deck": {
  "type": "html",
  "sources": [
    { "src": "slides/index.html" },
    { "src": "https://backup.example/slides/index.html" }
  ],
  "slideCount": 23
}
```

| `type`  | Notes |
|---------|-------|
| `html`  | reveal.js / `<deck-stage>` web components / generic `<section>` decks, in an iframe. Same-origin decks get full bidirectional control. |
| `pdf`   | rendered with pdf.js. |
| `embed` | an **external, embeddable slide URL** (Google Slides publish-to-web, SpeakerDeck, Canva, generic slide sites) shown read-only in an iframe. Display-only — the slide counter comes from `deck.slideCount` / `timing` — with opt-in deep-linking via `deck.embed` (below). For tight slide↔video sync, prefer `html` or `pdf`. |

- `deck.embed` *(optional, `type:"embed"` only)* — lets the player point the
  embedded URL at a slide. `{ "nav": "hash" \| "query", "param": "slide", "offset": 1 }`:
  `nav` chooses `#param=N` (no reload) vs `?param=N` (reloads the frame), `param`
  is the slide parameter name, and `offset` is the value for slide 1 (e.g. `0`
  for a 0-based embed). Omit for a purely display-only embed. Example:

  ```json
  "deck": {
    "type": "embed",
    "sources": [{ "src": "https://docs.google.com/presentation/d/ABC/embed" }],
    "slideCount": 18,
    "embed": { "nav": "query", "param": "slide", "offset": 0 }
  }
  ```
- `deck.slideCount` *(optional; **required for `embed`**)* — total slides, used
  for the counter when the deck engine can't report its own count.
- `deck.thumbnails` *(optional)* — authored slide previews for the scrubber.
  Either an array of image URLs indexed by slide (1-based), or an array of
  `{ "slide": N, "src": "…" }`. URLs follow the same transport rules
  (plain / `ipfs://` / `magnet:`) and resolve against the manifest URL if
  relative. **PDF decks auto-render** scrubber thumbnails from the page, so this
  is only needed for HTML decks (or to override). Example:

  ```json
  "deck": {
    "type": "html",
    "sources": [{ "src": "slides/index.html" }],
    "thumbnails": ["thumbs/1.png", "thumbs/2.png"]
  }
  ```
- **P2P decks.** A deck `src` may also be `ipfs://…` (expanded to the gateway
  fallback list at load) or a `magnet:` link (the `.html` / `.pdf` is fetched
  from the swarm and shown from a Blob URL). So the deck — not just the video —
  can live entirely on the decentralized web.

---

### timing

Slide-boundary cues — what slide is showing at what point in the video. It is
either an **inline array** or a **string path** to an external JSON file.

**Inline:**

```json
"timing": [
  { "time": 0.0,  "slide": 1, "transition": "cut",  "label": "Title" },
  { "time": "1:30", "slide": 2, "transition": "fade" }
]
```

**External file** (a JSON array, or `{ "timing": [ … ] }`), resolved relative to the manifest:

```json
"timing": "timing.json"
```

Cue fields:

| Field        | Type            | Required | Notes |
|--------------|-----------------|:--------:|-------|
| `time`       | number \| string|    no    | Float **seconds**, or a `"HH:MM:SS.mmm"` / `"MM:SS"` string. Defaults to 0. |
| `slide`      | integer ≥ 1     |  **yes** | **1-based** slide number. |
| `transition` | string          |    no    | `cut` \| `fade` \| `slide` \| `none`. Defaults to `cut`. |
| `label`      | string          |    no    | Author note (ignored by the player). |

Cues are sorted by `time`. The slide shown at any moment is the last cue whose
`time` ≤ the video's current time. (The internal engine still exposes these as
`manifest.sync`; `timing` is the authoring name.)

---

### subtitles

Caption tracks. Both **WebVTT** (`.vtt`) and **SubRip** (`.srt`) are accepted;
`.srt` is converted to WebVTT in the browser at load.

```json
"subtitles": [
  { "lang": "en", "label": "English", "src": "subs/en.vtt", "default": true },
  { "lang": "fa", "label": "فارسی",   "src": "subs/fa.srt", "format": "srt" }
]
```

| Field     | Type    | Required | Notes |
|-----------|---------|:--------:|-------|
| `lang`    | string  |    no    | BCP-47 tag or any unique key. |
| `label`   | string  |    no    | Shown in the Subtitles menu. |
| `src`     | string  |  **yes** | URL to the `.vtt` / `.srt` (resolved if relative). |
| `format`  | string  |    no    | `vtt` \| `srt`. Inferred from the extension if omitted. |
| `default` | boolean |    no    | If `true`, shown on load. |

**Rendering + placement.** A **Subtitles** menu in the control bar picks the
language (or turns captions off) and chooses where captions are drawn, governed
by `layout.captionPlacement`:

- **`window`** *(default)* — a synced caption **overlay** pinned along the bottom
  of the **whole player** (slides + video together), readable in every layout
  mode and in fullscreen. Driven by the sync clock; works for any provider.
- **`video`** — captions stay inside the **video pane** only: native HTML5
  `<track kind="subtitles">` for the `mp4` provider (rendered/styled by the
  browser), or a synced overlay-in-pane for `youtube` (whose iframe can't accept
  external tracks).

The viewer can switch placement live from the menu; their choice is persisted to
`localStorage` and overrides the manifest default.

---

### resolvers

Override the default networks the decentralized providers consume. Stored on the
manifest and passed to the `ipfs` / `webtorrent` video providers, the P2P deck
loader, and any `ipfs://` asset resolution.

```json
"resolvers": {
  "ipfsGateways": ["https://{cid}.ipfs.dweb.link", "https://ipfs.io/ipfs/{cid}"],
  "webtorrentTrackers": ["wss://tracker.openwebtorrent.com"]
}
```

- `ipfsGateways` — gateway URL templates; `{cid}` is substituted.
- `webtorrentTrackers` — `wss://` tracker URLs.

If omitted, sensible defaults are used.

---

### layout

The default layout. **The viewer's interactive changes (divider ratio, mode, PiP
position/size) are persisted to `localStorage` and override these defaults.**

```json
"layout": { "split": 0.6, "mode": "split", "transition": "fade", "captionPlacement": "window" }
```

| Field              | Type   | Notes |
|--------------------|--------|-------|
| `split`            | number | Slides-pane fraction of the split. `0–1`, clamped to `0.15–0.85`. Default `0.6`. |
| `mode`             | string | `split` \| `slides-focus` \| `video-focus` \| `overlap`. Default `split`. |
| `transition`       | string | Preferred default slide transition. Default `fade`. |
| `captionPlacement` | string | `window` (full player) \| `video` (video pane). Default `window`. See [subtitles](#subtitles). |

**Layout modes.** The control-bar **Layout** cluster shows each mode as a small
glyph that depicts its pane split, with a short label (Split / Slides / Video /
PiP) and a tooltip:

- **`split`** *(⬚⬚ equal panes)* — slides and video side by side with a
  **draggable divider**.
- **`slides-focus`** *(▭▏ large + small)* — slides large, video small on the side.
- **`video-focus`** *(▏▭ small + large)* — video large, slides small on the side.
- **`overlap`** *(▭ with a corner inset)* — slides fill the stage, video floats as
  a **draggable, resizable picture-in-picture** overlay.

A fifth **Fullscreen** glyph (corner-bracket frame, label "Full") sits in the
same cluster. Switch modes from the switcher or with the keyboard (`m` cycles);
fullscreen is that button or the `f` key.

### sig

An **optional** author signature. It proves *who published* a manifest: the
player verifies it on load and shows a **"✓ signed by …"** badge when valid (a
subtle "unsigned" pill otherwise) — but it **never blocks playback**. A manifest
without `sig` is fully valid; add or remove the block freely.

```json
"sig": {
  "alg": "eip191",
  "signer": { "address": "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23" },
  "signature": "0x…65 bytes…",
  "canon": "p2/jcs-1"
}
```

| Field       | Type   | Notes |
|-------------|--------|-------|
| `alg`       | string | `eip191` (Ethereum wallet / raw secp256k1 key) \| `ed25519` (raw keypair). |
| `signer`    | object | `eip191` → `{ address }`. `ed25519` → `{ key, domain? }` where `key` is the 32-byte raw public key, base64url. |
| `signature` | string | `eip191`: `0x` + r(32) + s(32) + v(1) hex (65 bytes). `ed25519`: base64url of the 64-byte signature. |
| `canon`     | string | Canonicalization id — use `p2/jcs-1`. |

**What is signed.** The signed payload is the **canonical JSON of the whole
manifest** — including this block's `alg`, `signer`, and `canon`, but with
`signature` removed. Canonical JSON (`p2/jcs-1`) recursively **sorts object keys**
and uses minimal separators over UTF-8 (a JCS-lite form). Because the `signer`
claim is itself inside the signed bytes, editing the manifest *or* the claimed
signer breaks verification.

- **`eip191`** — the message is the canonical string, hashed with the EIP-191
  `personal_sign` prefix (`"\x19Ethereum Signed Message:\n" + len + msg`) and
  signed by an Ethereum key. On load the player **recovers the address** from the
  signature; the manifest is valid only if it equals `signer.address`. The address
  is therefore self-authenticating, and the player **reverse-resolves it to an ENS
  name** for the badge (read-only public RPC, forward-confirmed, graceful
  fallback to `0x1234…abcd`).
- **`ed25519`** — the canonical string is signed with a raw Ed25519 key
  (WebCrypto). The 32-byte public key lives in `signer.key`; the signature
  verifies against it. An optional `signer.domain` is a display label bound into
  the signature.

Sign in the **[Builder](builder/)** (connect a wallet, paste an Ethereum private
key, or generate an Ed25519 key) — see [AUTHORING.md](AUTHORING.md). The
implementation is dependency-free and runs identically in the browser and Node
(`docs/src/sign.js`, `docs/src/crypto/`).

---

## Source transports

A *source* is any string p2present is asked to fetch — the manifest, the video,
the deck, subtitles, the poster, an external timing file. Four transports are
recognised, anywhere a `src` is accepted:

| Transport  | Form | Resolution |
|------------|------|------------|
| **https**  | `https://host/path` (or a path relative to the manifest) | fetched directly; relative paths resolve against the manifest's URL |
| **arweave**| `ar://<txid>[/path]` | expanded against the built-in Arweave gateways (`arweave.net`, then `ar-io.net`), tried in order until one responds |
| **ipfs**   | `ipfs://<cid>[/path]` or a bare `Qm…` / `bafy…` CID | expanded against `resolvers.ipfsGateways` (`{cid}` placeholder, or `…/ipfs/<cid>`), tried in order until one responds |
| **magnet** | `magnet:?xt=urn:btih:…` | added to the WebTorrent swarm with `resolvers.webtorrentTrackers`; the matching file is streamed (`<video>`) or read into a Blob URL (deck / manifest) |

Bare tokens that are neither a path nor a CID (e.g. a YouTube id) are left
verbatim for the provider.

These references are produced by **persistence providers** — a pluggable
interface (`docs/src/persist/`, mirroring the video providers) that the Host page
uses to turn a file into a reference: `arweave` → `ar://` (pay-once permanent),
`pinning` → `ipfs://`, `seedbox` → `magnet:`, `s3` → `https`. A "Make permanent"
payment hook (Stripe / on-chain rent) is defined but unwired in the static build.
See [HOSTING.md](HOSTING.md) and [SERVICE.md](SERVICE.md#make-permanent).

> **Self-hosting needs no gateway.** If every `src` is a plain `https` URL on
> your own server, p2present never touches a public IPFS gateway or tracker —
> there is no hard dependency on any third party being up. ipfs/magnet are opt-in
> per source, and always degrade to the next `sources[]` entry on failure.

---

## Loading & sharing (query args & base64)

The resolver host (`docs/index.html`) decides what to load from the URL query —
**first match wins**:

| Query | Meaning |
|-------|---------|
| `?src=<base64>`   | base64-decoded value is **either** an inline `p2present.json` **or** a source URL/CID/magnet (auto-detected by a leading `{`). The compact, self-contained share format. |
| `?manifest=<url>` | load a `p2present.json` from that source — any transport (`https` / `ipfs://` / `magnet:`). |
| `?p=<name>`       | a bundled local manifest shipped in the fork at `content/<name>/manifest.json` (name limited to `[\w.-]`). |
| *(none)*          | the bundled demo (`content/demo/manifest.json`). |

The base64 is UTF-8 safe (`btoa(unescape(encodeURIComponent(str)))`) and tolerates
the URL-safe alphabet (`-`/`_`).

**Share-link scheme.** The header's **🔗 Share** button opens a small popover
(YouTube-style) with two options:

- **Copy presentation link** — base64-encodes the current presentation's source
  into a self-contained, hash-free link of the form:

  ```
  https://<host>/<path>?src=<base64-of-the-current-source>
  ```

- **Copy link to this moment** — the same link plus a `#t=…&slide=…` deep-link
  (below) pointing at exactly where you are.

Each option copies to the clipboard (and updates the address bar), with a status
confirmation. Examples:

```
# share an https-hosted talk
…/p2present/?src=aHR0cHM6Ly9leGFtcGxlLmNvbS90YWxrL3AycHJlc2VudC5qc29u

# the decoded value can equally be  ipfs://bafy…/p2present.json  or  magnet:?xt=…
```

### Deep-links (`#t=…&slide=…`)

A **hash fragment** opens the player at a precise spot and composes with any
loader above:

| Hash key | Meaning |
|----------|---------|
| `t`     | seconds into the video (float; the player seeks here on load) |
| `slide` | 1-based slide number (the deck jumps here on load) |

Either key may be omitted; if only `t` is given, the slide is derived from the
timing cues at that time. Examples:

```
…/p2present/?p=demo#t=575&slide=13      # open at 9:35, slide 13
…/p2present/?src=<base64>#t=120          # open a shared deck at 2:00
```

As you navigate, the player rewrites the hash (debounced, via
`history.replaceState`) so the address bar always points at the current spot, and
the Share menu's **📍 Copy link to this moment** option copies a
`?src=<base64>#t=…&slide=…` link to exactly where you are.

---

## Tooling

- **[Builder](https://p2present.com/builder/)** (`docs/builder/`) —
  assemble/edit a manifest visually with live JSON + validation against this
  schema, then download / copy / open-in-player. See [AUTHORING.md](AUTHORING.md).
- **[Host helper](https://p2present.com/host/)** (`docs/host/`) —
  upload an asset through a pluggable **persistence provider** (Arweave / IPFS
  pinning / WebTorrent seedbox / S3) to produce an `ar://` / `ipfs://` / `magnet:`
  / `https` reference. See [HOSTING.md](HOSTING.md).

---

## Validation

Validate a manifest against the JSON Schema with any draft-07 validator, e.g.:

```bash
npx --yes ajv-cli validate -s docs/p2present.schema.json -d docs/content/demo/manifest.json
```
