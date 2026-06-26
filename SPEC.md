# p2present manifest specification — `p2present.json` v1.0

A presentation in p2present is described by a single JSON manifest. This document
is the canonical reference for the **v1.0** schema. A machine-readable JSON Schema
lives at [`docs/p2present.schema.json`](docs/p2present.schema.json).

Every source in a manifest — the manifest itself, the video, the deck, and
assets — may be a plain **`https`** URL, an **`ipfs://`** CID, or a **`magnet:`**
link. See [Source transports](#source-transports) and
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

| `type` | Notes |
|--------|-------|
| `html` | reveal.js / `<deck-stage>` web components / generic `<section>` decks, in an iframe. Same-origin decks get full bidirectional control. |
| `pdf`  | rendered with pdf.js. |

- `deck.slideCount` *(optional)* — total slides, used for the counter when the
  deck engine can't report its own count.
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
| `label`   | string  |    no    | Shown in the CC menu. |
| `src`     | string  |  **yes** | URL to the `.vtt` / `.srt` (resolved if relative). |
| `format`  | string  |    no    | `vtt` \| `srt`. Inferred from the extension if omitted. |
| `default` | boolean |    no    | If `true`, shown on load. |

**Rendering.** For the `mp4` provider, tracks are attached as real HTML5
`<track kind="subtitles">` elements and rendered/styled by the browser. For
`youtube` (whose iframe can't accept external tracks), p2present renders a synced
caption **overlay** driven by the sync clock. A **CC menu** in the control bar
lets the viewer pick a language or turn captions off.

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
"layout": { "split": 0.6, "mode": "split", "transition": "fade" }
```

| Field        | Type   | Notes |
|--------------|--------|-------|
| `split`      | number | Slides-pane fraction of the split. `0–1`, clamped to `0.15–0.85`. Default `0.6`. |
| `mode`       | string | `split` \| `slides-focus` \| `video-focus` \| `overlap`. Default `split`. |
| `transition` | string | Preferred default slide transition. Default `fade`. |

**Layout modes:**

- **`split`** — slides and video side by side with a **draggable divider**.
- **`slides-focus`** — slides large, video small on the side.
- **`video-focus`** — video large, slides small on the side.
- **`overlap`** — slides fill the stage, video floats as a **draggable, resizable
  picture-in-picture** overlay.

Switch modes from the control-bar switcher or with the keyboard (`m` cycles).
Fullscreen is the `⛶` button or the `f` key.

---

## Source transports

A *source* is any string p2present is asked to fetch — the manifest, the video,
the deck, subtitles, the poster, an external timing file. Three transports are
recognised, anywhere a `src` is accepted:

| Transport  | Form | Resolution |
|------------|------|------------|
| **https**  | `https://host/path` (or a path relative to the manifest) | fetched directly; relative paths resolve against the manifest's URL |
| **ipfs**   | `ipfs://<cid>[/path]` or a bare `Qm…` / `bafy…` CID | expanded against `resolvers.ipfsGateways` (`{cid}` placeholder, or `…/ipfs/<cid>`), tried in order until one responds |
| **magnet** | `magnet:?xt=urn:btih:…` | added to the WebTorrent swarm with `resolvers.webtorrentTrackers`; the matching file is streamed (`<video>`) or read into a Blob URL (deck / manifest) |

Bare tokens that are neither a path nor a CID (e.g. a YouTube id) are left
verbatim for the provider.

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

**Share-link scheme.** The header's **🔗 Share** button base64-encodes the current
presentation's source and writes a self-contained link of the form:

```
https://<host>/<path>?src=<base64-of-the-current-source>
```

It is copied to the clipboard (and the address bar is updated). Examples:

```
# share an https-hosted talk
…/p2present/?src=aHR0cHM6Ly9leGFtcGxlLmNvbS90YWxrL3AycHJlc2VudC5qc29u

# the decoded value can equally be  ipfs://bafy…/p2present.json  or  magnet:?xt=…
```

---

## Validation

Validate a manifest against the JSON Schema with any draft-07 validator, e.g.:

```bash
npx --yes ajv-cli validate -s docs/p2present.schema.json -d docs/content/demo/manifest.json
```
