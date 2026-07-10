# p2present 🎞️

**Presentations that play themselves — slides and talk video in perfect sync, on a 100% static, forkable page.**

No server, no build step, no dependencies. One repo is both a **player** (paste any manifest source — `https`, `ar://`, `ipfs://`, `magnet:` — and it plays) and a **self-host template** (fork it, drop in your content, enable GitHub Pages).

**▶ Live:** [p2present.com](https://p2present.com/)

| | |
|---|---|
| **[Player](https://p2present.com/app/)** | scrub the talk, the slides follow — and vice versa |
| **[HTML deck demo](https://p2present.com/app/?p=demo)** · **[PDF deck demo](https://p2present.com/app/?p=moav-pdf)** | the MoaV talk, synced to its [YouTube video](https://www.youtube.com/watch?v=uYygWN1MZDE) |
| **[🛠 Builder](https://p2present.com/builder/)** | assemble a `p2present.json` visually — live preview, validation, timing capture |
| **[📤 Host helper](https://p2present.com/host/)** | put an asset on Arweave / IPFS / WebTorrent / S3, get a manifest reference back |

![Slides synced to the YouTube talk](docs/screenshots/demo-youtube-1280.png)

| PDF deck + scrubber thumbnails | Signed-manifest badge |
|---|---|
| ![PDF deck demo](docs/screenshots/pdf-demo.png) | ![Verified signer badge](docs/screenshots/signed-badge.png) |

## Features

- **Bidirectional sync** — play/scrub the video and slides follow; navigate slides and the video seeks. A 🔗 toggle unlinks them.
- **Any deck** — HTML decks, **PDF** (pdf.js), or an **embed** URL (Google Slides / SpeakerDeck / Canva).
- **Any video, with fallback** — `youtube`, `mp4`, `webtorrent` (magnet), `ipfs` (CID via gateways); list several sources and the first that loads wins.
- **Decentralized everything** — the manifest and every asset can load from `https`, `ar://`, `ipfs://`, or `magnet:`. No hard gateway dependency; p2p sources fall through gracefully.
- **Four layouts** — split (draggable divider) · slides-focus · video-focus · draggable/resizable PiP, plus fullscreen with auto-hiding controls. Mobile-tuned throughout.
- **Subtitles** — `.vtt` and `.srt`, multi-language, drawn over the whole player or inside the video pane.
- **Share anything** — self-contained `?src=<base64>` links, `#t=…&slide=…` deep-links to a moment, and an optional [sharing service](SERVICE.md) for short `…/p/<id>` links.
- **Signed manifests** — sign with an Ethereum wallet (EIP-191, ENS-badged) or Ed25519 key; the player verifies on load and never blocks playback.
- **Scrubber thumbnails** — hover the timeline to preview the slide at that moment.

## Quick start

```bash
git clone https://github.com/shayanb/p2present
cd p2present
npm run preview        # serves ./docs at http://localhost:5173
```

Native ES modules — any static server works, but `file://` won't.

## Fork & self-host

The whole site is the **`docs/`** folder, served as-is by GitHub Pages:

1. **Fork** this repo (or use it as a template).
2. Add your slides + `manifest.json` under `docs/content/<your-talk>/`.
3. **Settings → Pages** → deploy from branch → `main` / `docs`.
4. Your talk is live at `https://<you>.github.io/<repo>/app/?p=<your-talk>`.

Keep `docs/.nojekyll` (Pages' Jekyll would drop `_`-prefixed deck assets). You can also skip forking entirely: point the public player at any remote manifest with `…/app/?manifest=<url|ipfs://|magnet:>` (cross-host `https` needs CORS).

## The manifest

One `p2present.json` describes a presentation — video sources, deck, timing cues, subtitles:

```jsonc
{
  "p2present": "1.0",
  "title": "My Talk",
  "video": { "sources": [ { "provider": "youtube", "src": "uYygWN1MZDE" } ] },
  "deck":  { "type": "pdf", "sources": [ { "src": "slides.pdf" } ], "slideCount": 23 },
  "timing": [
    { "time": 0,    "slide": 1 },
    { "time": 12.5, "slide": 2, "transition": "fade" }
  ],
  "subtitles": [ { "lang": "en", "src": "subs/en.srt", "default": true } ]
}
```

Full reference in **[SPEC.md](SPEC.md)** (+ machine-readable [JSON Schema](docs/p2present.schema.json)). Easiest path: build it in the **[Builder](https://p2present.com/builder/)**, or bootstrap `timing[]` from YouTube chapters with `node scripts/import-chapters.mjs`.

## Documentation

| Guide | What's in it |
|---|---|
| **[SPEC.md](SPEC.md)** | every manifest field, source transports, share/deep-link formats |
| **[AUTHORING.md](AUTHORING.md)** | make a presentation start-to-finish |
| **[HOSTING.md](HOSTING.md)** | putting assets on Arweave / IPFS / WebTorrent / S3 |
| **[SERVICE.md](SERVICE.md)** | the optional "Save & share" backend (Cloudflare Worker + KV) — deploy, domain + SSL |
| **[DOCS.md](DOCS.md)** | one-page index of everything |
| **[ROADMAP.md](ROADMAP.md)** | what's next — open core, free forever |

## Extending

Everything domain-specific is a small module in a registry — video providers (`docs/src/video/`), deck adapters (`docs/src/decks/`), slide transitions (`docs/src/transitions/`), and persistence providers (`docs/src/persist/`). Extend the base class, register it in the matching `index.js`, done — the UI picks it up automatically. Existing modules are the reference implementations.

```js
videoProviders.register('vimeo', VimeoProvider);      // docs/src/video/index.js
persistProviders.register('swarm', SwarmProvider);    // docs/src/persist/index.js
```

## Development

```bash
npm test           # unit tests (node, no deps)
npm run smoke      # headless-Chrome smoke suite + screenshot refresh
```

`service/` holds the optional sharing-service Worker (own [deploy guide](SERVICE.md), own tests).

## License

MIT (see `LICENSE`). The bundled demo deck under `docs/content/` belongs to its original author and is included for demonstration only — replace it with your own when you fork.
