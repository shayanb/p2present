# Hosting your presentation assets

A p2present presentation is just a `p2present.json` manifest that points at your
assets — the **talk video**, the **slide deck** (HTML or PDF), optional
**subtitles**, and slide **thumbnails**. p2present never hosts anything for you:
you choose where each asset lives and put a reference to it in the manifest.

Every `src` in a manifest can be one of four transport kinds, and you can mix
them freely (even as an ordered fallback list — see [SPEC.md](SPEC.md)):

| Transport | Looks like | Best for |
|-----------|-----------|----------|
| **Plain URL** | `https://host/talk.mp4` | self-hosting, any static host, a CDN, S3 |
| **Arweave** | `ar://<txid>` or `<txid>/path` | pay-once **permanent** storage (permaweb) |
| **IPFS** | `ipfs://<cid>` or `<cid>/path` | content-addressed, gateway-served, optionally pinned |
| **WebTorrent** | `magnet:?xt=urn:btih:…` | peer-to-peer streaming, no server |

The **[Host helper page](https://p2present.com/host/)** turns a file
into one of these references in your browser. It is built around a pluggable
**persistence-provider** interface (mirroring the video-provider pattern): pick a
provider, supply the config it needs, upload, and copy the reference into the
Builder. Four providers ship:

| Provider | Produces | Model | Module |
|----------|----------|-------|--------|
| **arweave** *(default)* | `ar://` | pay-once permanent | `docs/src/persist/arweave.js` |
| **pinning** | `ipfs://` | Pinata / web3.storage (rent) | `docs/src/persist/pinning.js` |
| **seedbox** | `magnet:` | WebTorrent (in-tab + always-on) | `docs/src/persist/seedbox.js` |
| **s3** | `https` | S3 / presigned PUT | `docs/src/persist/s3.js` |

Add your own with `persistProviders.register('filecoin', FilecoinProvider)` — one
class with a `put(file) → { ref, scheme }` method (see `docs/src/persist/index.js`).

> The whole site is static (GitHub Pages). The Host page runs entirely in your
> browser — your files and API tokens go directly to the provider you pick
> (Arweave node, Pinata, web3.storage, the WebTorrent swarm, your bucket), never
> to a p2present server.

---

## 1. Plain URLs (self-host / any static host)

The simplest option: drop the files on any web server that sends
[CORS](#cors) headers and reference them by URL.

```jsonc
{
  "video": { "sources": [{ "provider": "mp4", "src": "https://media.example.com/talk.mp4" }] },
  "deck":  { "type": "html", "sources": [{ "src": "https://example.com/slides/index.html" }] }
}
```

- **YouTube** is the zero-hosting path for video — upload the talk and use the
  video id: `{ "provider": "youtube", "src": "uYygWN1MZDE" }`.
- **Relative paths** in a manifest resolve against the manifest's own URL, so you
  can ship `p2present.json` next to a `slides/` folder and reference
  `{ "src": "slides/index.html" }`. This is exactly how the bundled demo works
  (`docs/content/demo/`).
- **GitHub Pages** is a great free static host: commit your assets, enable Pages,
  and your URLs are `https://<user>.github.io/<repo>/…`. Fork this repo to get the
  player + a `/docs` Pages setup for free (see the README).
- **S3 / object storage** — the Host page's **s3** provider PUTs a file to a
  presigned URL (or any PUT endpoint) you supply, then references the public
  object URL. Make the object publicly readable and CORS-enabled. Nothing is
  stored by p2present; the presigned URL + public URL stay in your browser.

### Mapping to the manifest

| Asset | Entry |
|-------|-------|
| Video file | `video.sources[] = { "provider": "mp4", "src": "https://…/talk.mp4" }` |
| YouTube | `video.sources[] = { "provider": "youtube", "src": "<id or watch URL>" }` |
| HTML deck | `deck = { "type": "html", "sources": [{ "src": "https://…/index.html" }] }` |
| PDF deck | `deck = { "type": "pdf", "sources": [{ "src": "https://…/slides.pdf" }] }` |
| Subtitles | `subtitles[] = { "lang": "en", "src": "https://…/en.vtt" }` |

---

## 2. Arweave (permanent — pay once)

Arweave is **pay-once permanent** storage: you fund an upload once and the data
lives on the *permaweb* indefinitely (no recurring rent, unlike a pinning
service). A manifest references it as `ar://<txid>` (optionally with a sub-path).
The player resolves that to an Arweave gateway (`arweave.net`, then `ar-io.net`),
so produced references play directly.

Because a static page can't sign + fund an Arweave transaction without a heavy
wallet bundle, the Host page's **arweave** provider uploads through an **upload
service you point it at** — an [Irys](https://irys.xyz) / [Turbo (ArDrive)](https://ardrive.io)
node, or any bundler that accepts an authenticated `POST` of the bytes and
returns a JSON body with the transaction id (`{ "id": "…" }`). Enter the endpoint
URL (and a Bearer token if your node needs one) in the Host page — both are kept
**only in your browser**. Click **Make permanent 💎** and you get back
`ar://<txid>`.

```jsonc
{
  "video": { "sources": [{ "provider": "mp4", "src": "ar://<txid>/talk.mp4" }] },
  "deck":  { "type": "pdf", "sources": [{ "src": "ar://<txid>" }] }
}
```

> The player tries the built-in Arweave gateway list (`arweave.net`, then
> `ar-io.net`) in order. Any `ar://` reference also works as a plain
> `https://arweave.net/<txid>` URL if you'd rather hard-code a gateway.

### "Make it permanent" without your own credits (payment hook)

If you **don't** configure an upload endpoint, **Make permanent 💎** instead calls
p2present's **payment hook** — the place a paid deployment would charge for the
upload (Stripe fiat, or an on-chain rent path) and fund it for you. This static
build ships **no payment keys**, so the button surfaces a clear note explaining
how to wire one. The adapter boundary and both rails (Stripe + on-chain) are
documented in **[SERVICE.md → Wiring the "Make permanent" button](SERVICE.md#make-permanent)**.

### Mapping to the manifest

| Asset | Entry |
|-------|-------|
| Video | `video.sources[] = { "provider": "mp4", "src": "ar://<txid>" }` |
| Deck (html/pdf) | `deck.sources[] = { "src": "ar://<txid>" }` (or `ar://<txid>/index.html`) |
| Subtitles | `subtitles[] = { "src": "ar://<txid>" }` |

---

## 3. IPFS

IPFS addresses content by hash (a **CID**). Anyone with the CID can fetch the
file through any gateway, and the same reference works forever regardless of who
serves it. In a manifest you write `ipfs://<cid>` (optionally with a sub-path,
e.g. `ipfs://<cid>/index.html`). The player expands that to a list of HTTP
gateways and tries each until one responds (configurable via `resolvers.ipfsGateways`).

### 3a. Without your own pin (quick, ephemeral)

If a file is already on the IPFS network (someone is providing it), you only need
its CID — no account required. But **nobody is obliged to keep it around**: if no
node pins it, it can disappear from gateways. Good for experiments; not for a talk
you want to last.

### 3b. With your own pin (durable) — recommended

A **pinning service** keeps your CID available. The Host page supports two
providers, each using a token **you** create and that is stored **only in your
browser's localStorage** (never hardcoded, never sent to p2present):

- **Pinata** — create a **JWT** at <https://app.pinata.cloud> → *API Keys*. Paste
  it into the Host page, choose a file, and click **Upload & pin**. You get back a
  CID and a ready `ipfs://<cid>` reference.
- **web3.storage** — paste a legacy API token (`api.web3.storage`). For the newer
  **Storacha / w3up** flow, use the CLI instead:

  ```bash
  npm install -g @web3-storage/w3cli
  w3 login you@example.com         # email auth
  w3 space create my-talk          # one-time
  w3 up talk.mp4                    # prints the CID
  ```

Either way, the result is a CID. Reference it in the manifest:

```jsonc
{
  "video": { "sources": [{ "provider": "ipfs", "src": "ipfs://bafy…video" }] },
  "deck":  { "type": "pdf", "sources": [{ "src": "ipfs://bafy…deckcid" }] }
}
```

### Custom gateways

Override the gateways the player tries (handy if you run your own):

```jsonc
"resolvers": { "ipfsGateways": ["https://{cid}.ipfs.dweb.link", "https://ipfs.io/ipfs/{cid}"] }
```

`{cid}` is substituted with your CID; a template without `{cid}` is treated as a
`…/ipfs/<cid>` gateway root.

### Mapping to the manifest

| Asset | Entry |
|-------|-------|
| Video | `video.sources[] = { "provider": "ipfs", "src": "ipfs://<cid>" }` |
| Deck (html/pdf) | `deck.sources[] = { "src": "ipfs://<cid>" }` (or `ipfs://<cid>/index.html`) |
| Subtitles | `subtitles[] = { "src": "ipfs://<cid>" }` |

---

## 4. WebTorrent

WebTorrent streams files peer-to-peer over WebRTC, addressed by a **magnet** URI.
There's no server: as long as at least one peer is seeding the file, the player
can stream it.

### 4a. Browser-tab seeding (Host page) — quick demos

On the Host page, choose the **seedbox** provider, pick a file, and click
**Create & seed**. The tab hashes the file, announces to the trackers, and shows
the **magnet URI**. Paste it into a manifest.

> ⚠️ Browser-tab seeding lasts only while **that tab stays open**. The moment you
> close it, no one is seeding and the magnet stops resolving (until another peer
> appears). Fine for a live demo; use an always-on seedbox or the CLI below for
> anything persistent.

### 4b. Always-on seedbox (Host page) — persistent, no CLI

The **seedbox** provider has an optional **always-on seedbox URL** field. When set,
after creating the torrent the Host page also `POST`s `{ magnet, name }` to that
endpoint (with an optional Bearer token) — a remote always-on WebTorrent client
**you** run that keeps seeding the magnet after your tab closes. The result is
tagged **always-on** in the UI. (The seedbox itself is your own small service —
e.g. `webtorrent-cli` driven by a tiny HTTP listener, or a hosted torrent box.)

### 4c. CLI seeding (`webtorrent-cli`) — persistent

For always-on seeding, run a seeder on a machine that stays up:

```bash
npm install -g webtorrent-cli
# Seed a file and print its magnet (keep this process running):
webtorrent seed talk.mp4
# Seed with the same WebRTC trackers the browser player uses, so web peers connect:
webtorrent seed talk.mp4 \
  --announce wss://tracker.openwebtorrent.com \
  --announce wss://tracker.webtorrent.dev
```

> Browser players speak **WebRTC** (`wss://`) trackers; a classic BitTorrent
> client on TCP/UDP won't necessarily connect to web peers. Seed with `wss://`
> trackers (and ideally a hybrid client) so the in-browser player can reach you.
> You can pin the tracker list in the manifest via `resolvers.webtorrentTrackers`.

### Mapping to the manifest

| Asset | Entry |
|-------|-------|
| Video | `video.sources[] = { "provider": "webtorrent", "src": "magnet:?xt=urn:btih:…" }` |
| Deck (html/pdf) | `deck.sources[] = { "src": "magnet:?xt=urn:btih:…" }` (the adapter fetches the file from the swarm) |
| Trackers | `resolvers.webtorrentTrackers = ["wss://tracker.openwebtorrent.com", …]` |

A magnet that bundles multiple files: the deck adapter picks the file matching
the deck type (`.html`/`.pdf`); the video provider picks the largest media file.

---

## 5. Resilience: fallback source lists

`video.sources` and `deck.sources` are **ordered fallback lists** — the player
tries each in order until one loads. Combine transports so a single dead host or
gateway doesn't break playback:

```jsonc
"video": {
  "sources": [
    { "provider": "ipfs",       "src": "ipfs://bafy…video" },
    { "provider": "webtorrent", "src": "magnet:?xt=urn:btih:…" },
    { "provider": "mp4",        "src": "https://media.example.com/talk.mp4" },
    { "provider": "youtube",    "src": "uYygWN1MZDE" }
  ]
}
```

---

## 6. Thumbnails (optional)

PDF decks auto-render scrubber thumbnails — nothing to host. For HTML decks (or to
override), host small slide images and list them:

```jsonc
"deck": {
  "type": "html",
  "sources": [{ "src": "slides/index.html" }],
  "thumbnails": ["thumbs/1.png", "thumbs/2.png", "…"]   // indexed by slide
}
```

or `"thumbnails": [{ "slide": 1, "src": "thumbs/1.png" }, …]`. URLs follow the
same transport rules (plain/ipfs/magnet) as any other asset.

---

## <a id="cors"></a>CORS note

The player fetches the manifest and its assets with `fetch()`/media elements from
the page's origin. If an asset lives on a **different host**, that host must send
`Access-Control-Allow-Origin` headers (most CDNs, IPFS gateways, and GitHub Pages
do by default). Self-hosted servers may need to enable CORS. YouTube and
WebTorrent are not subject to this (they use an iframe / WebRTC respectively).

---

## Hosting the manifest itself (optional sharing service)

Everything above hosts your **assets**; the `p2present.json` manifest that ties
them together still needs to live somewhere a link can point at. Three options,
simplest first:

1. **The sharing service ("Save & share").** With a [pastebin-lite service](SERVICE.md)
   deployed (or using the community one), the player's **💾 Save & share** button
   POSTs the current manifest and hands back a short `…/p/<id>` link — no file to
   host yourself. You keep an edit token (in your browser) to update it later.
   This is the **community-hosting backend**: a small Cloudflare Worker + KV that
   anyone can self-deploy — see **[SERVICE.md](SERVICE.md)**.
2. **A static URL.** Drop `p2present.json` on any CORS-enabled host and load it
   with `?manifest=https://…/p2present.json` (same rules as plain-URL assets above).
3. **Inline.** The 🔗 **Share → Copy presentation link** button base64-encodes the
   whole manifest into a self-contained `?src=<base64>` link — nothing to host at all.

> The sharing service never touches your **assets** — it only stores the small
> JSON manifest (which points at assets hosted however you chose above).

---

## Next step

Once your assets are hosted, open the **[Builder](https://p2present.com/builder/)**
to assemble the `p2present.json` visually (it can read the references you produced
on the Host page), then share the result. See the
[Authoring guide](AUTHORING.md) for the full start-to-finish workflow.
