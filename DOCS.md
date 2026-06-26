# p2present documentation

An index of everything. p2present is a forkable, **static** web app that plays
presentation slides in sync with the talk video — see the
**[live demo](https://ibeezhan.github.io/p2present/)**.

## Guides

| Doc | What it covers |
|-----|----------------|
| **[README.md](README.md)** | Overview, live demo, full feature list, quick start, fork & self-host, screenshots, project layout. |
| **[AUTHORING.md](AUTHORING.md)** | Make a presentation start-to-finish: slides → host assets → build the manifest → share. |
| **[HOSTING.md](HOSTING.md)** | Where to put your assets — plain URLs, IPFS (with/without your own pin), WebTorrent (browser vs CLI) — and how each maps to a manifest entry. |
| **[SERVICE.md](SERVICE.md)** | The optional "Save & share" backend: deploy a Cloudflare Worker + KV that hosts manifests behind short `…/p/<id>` links; configure the app to use it; optional IPFS mirror. |
| **[SPEC.md](SPEC.md)** | The canonical `p2present.json` v1.0 reference: every field, source transports, loading/share formats, deep-links, validation. |
| **[JSON Schema](docs/p2present.schema.json)** | Machine-readable manifest schema (draft-07) for validation. |

## Apps (on the live site)

| App | URL | Purpose |
|-----|-----|---------|
| **Player / resolver** | [`/`](https://ibeezhan.github.io/p2present/) | Load a presentation from a URL / `ipfs://` / `magnet:` / `?src=` and play it. |
| **HTML-deck demo** | [`/?p=demo`](https://ibeezhan.github.io/p2present/?p=demo) | The bundled `<deck-stage>` demo. |
| **PDF-deck demo** | [`/?p=moav-pdf`](https://ibeezhan.github.io/p2present/?p=moav-pdf) | The same talk rendered from a PDF (pdf.js adapter). |
| **Builder** | [`/builder/`](https://ibeezhan.github.io/p2present/builder/) | Build/edit a `p2present.json` visually with live preview + schema validation. |
| **Host helper** | [`/host/`](https://ibeezhan.github.io/p2present/host/) | Pin a file to IPFS / seed a WebTorrent in the browser. |

## Common tasks

- **Make a presentation** → [AUTHORING.md](AUTHORING.md)
- **Get assets onto IPFS / WebTorrent** → [HOSTING.md](HOSTING.md) · [Host helper](https://ibeezhan.github.io/p2present/host/)
- **Save & share a manifest behind a short link** → [SERVICE.md](SERVICE.md)
- **Sign a manifest (✓ signed by …)** → [AUTHORING → Sign it](AUTHORING.md#step-5--sign-it-optional) · [SPEC → sig](SPEC.md#sig)
- **Look up a manifest field** → [SPEC.md](SPEC.md)
- **Validate a manifest** → [SPEC → Validation](SPEC.md#validation)
- **Deep-link to a moment** → [SPEC → Deep-links](SPEC.md#deep-links-tslide)
- **Fork & self-host** → [README → Fork & self-host](README.md#fork--self-host)
- **Extend (new provider / deck / transition)** → [README → Extending](README.md#extending)

## Develop

```bash
npm run preview   # serve ./docs at http://localhost:5173 (no build step)
npm test          # unit tests (pure logic + schema validator + service Worker handlers)
npm run smoke     # headless-Chrome smoke + screenshots
```
