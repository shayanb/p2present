# deploy/ — p2present persistence backends

The self-hostable backends that the **Stripe "Make permanent" webhook** drives.
After an author pays (see [SERVICE.md → Make permanent](../SERVICE.md#make-permanent)),
the payments Worker calls the **control API** here, which turns a staged file into
a durable, content-addressed reference:

| Provider (chosen on the Host page) | Backend in this stack | Produces |
|---|---|---|
| `pinning` | **kubo** (IPFS) — `ipfs add` + pin | `ipfs://<cid>` |
| `seedbox` | **seed** — always-on WebTorrent seeder | `magnet:?xt=urn:btih:…` |
| `arweave` | **bundler** (external Irys/Turbo, optional) | `ar://<txid>` |
| `s3` | your bucket (out of stack) | `https://…` |

Everything is **plain Docker** — the same `docker compose` stack runs unchanged on
a Hetzner Cloud server or a DigitalOcean droplet. Persistent data lives in
**named volumes** so it survives container restarts and `compose down`.

> **Status: deployable reference, not provisioned.** These files are config +
> reference services. Nothing here is running live and **no credentials are
> committed** — only `.env.example`. The control + seed services are zero-/single-
> dependency reference implementations; review and load-test before production.

---

## Architecture

```
                                 Internet
                                    │
                      ┌─────────────┴──────────────┐
                      │  443 (TLS, Caddy)           │   4001  (IPFS swarm, public)
                      │  the ONLY app port exposed  │   6881  (BitTorrent peers)
                      ▼                             ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │  Docker host (Hetzner / DigitalOcean)        docker network: edge   │
   │                                                                     │
   │   ┌────────┐   reverse_proxy    ┌──────────────┐                    │
   │   │ caddy  │ ─────────────────▶ │  control:8090│  (internal only)   │
   │   │ TLS    │  control.domain    │   API        │                    │
   │   └────────┘                    └─────┬────────┘                    │
   │                                       │ internal network            │
   │                       ┌───────────────┼──────────────┐             │
   │                       ▼               ▼              ▼              │
   │                 ┌──────────┐   ┌───────────┐  ┌──────────────┐      │
   │                 │ ipfs:5001│   │ seed:8091 │  │ (arweave →   │      │
   │                 │ kubo API │   │ WebTorrent│  │  ext bundler)│      │
   │                 └────┬─────┘   └─────┬─────┘  └──────────────┘      │
   │  named volumes:      │               │                              │
   │   ipfs-data ◀────────┘   seed-data ◀─┘   staging-data (shared)      │
   │   control-data           caddy-data (TLS certs)                     │
   └───────────────────────────────────────────────────────────────────┘
```

- **caddy** terminates TLS (auto Let's Encrypt) and is the only service published
  on 443. The control/seed/kubo APIs stay on the docker networks.
- **kubo's API (5001) is never exposed to the host** — only reachable internally
  by the control service. Treat it as root-equivalent.
- The **swarm/peer ports** (IPFS 4001, BitTorrent 6881) are public so peers can
  reach the content; WebRTC players reach the seeder via the `wss://` trackers.

### Request flow (payment → reference)

```
1. Host page stages the file:   POST  https://control.domain/stage/<jobId>
                                       (raw bytes; unguessable jobId; size-capped)
2. Author pays via Stripe Checkout (payments Worker).
3. Stripe webhook → Worker → POST https://control.domain/jobs
       Authorization: Bearer <CONTROL_TOKEN>
       { jobId, provider, bytes, name }
4. control reads the staged file and:
       pinning → ipfs add+pin → ipfs://<cid>
       seedbox → seed service  → magnet:…
       arweave → bundler POST  → ar://<txid>   (if configured)
5. control returns { status:'persisted', ref, scheme }; the Worker records it.
6. Host page polls the Worker → reflects the ref into the manifest (Builder).
```

### How the Worker reaches the control API (auth)

A single shared secret. Generate one (`openssl rand -hex 32`) and set it in
**both** places:

- here: `CONTROL_TOKEN` in `deploy/.env`
- on the Worker: `npx wrangler secret put PERSIST_CONTROL_TOKEN --config wrangler.payments.toml`,
  and `PERSIST_CONTROL_URL = "https://control.domain/"` in `wrangler.payments.toml`.

`POST /jobs` requires `Authorization: Bearer <token>`. `POST /stage/<jobId>` is
token-less so a static browser can upload (it is guarded by the unguessable
`jobId` + a size cap) — for a public deployment, harden it with a Worker-minted
short-lived stage token or an allow-list/rate-limit at Caddy.

### How persistence maps back to manifest refs

The control API returns the canonical reference for the chosen transport, which
goes straight into a `p2present.json` source (see [HOSTING.md](../HOSTING.md)):

| Backend | Returned `ref` | Manifest usage |
|---|---|---|
| IPFS pin | `ipfs://<cid>` | `{ "provider": "ipfs", "src": "ipfs://<cid>" }` |
| WebTorrent seed | `magnet:?xt=urn:btih:…` | `{ "provider": "webtorrent", "src": "magnet:…" }` |
| Arweave | `ar://<txid>` | `{ "provider": "mp4", "src": "ar://<txid>" }` etc. |

The player already resolves all three transports with gateway/tracker fallback.

---

## Run it

```bash
cd deploy
cp .env.example .env          # set CONTROL_DOMAIN, ACME_EMAIL, CONTROL_TOKEN, …
#  point CONTROL_DOMAIN's DNS A/AAAA record at this host first (for TLS).
docker compose up -d --build
docker compose ps             # all healthy?
curl -sf https://$CONTROL_DOMAIN/healthz   # → {"ok":true}
```

Local smoke (no TLS) — talk to the control API directly:

```bash
# stage a file, then enqueue an IPFS pin as the Worker would
curl -X POST --data-binary @talk.pdf -H 'x-file-name: talk.pdf' \
     http://localhost:8090/stage/testjob1            # (publish 8090 in compose for local testing)
curl -X POST -H "authorization: Bearer $CONTROL_TOKEN" -H 'content-type: application/json' \
     -d '{"jobId":"testjob1","provider":"pinning","name":"talk.pdf"}' \
     http://localhost:8090/jobs                       # → { ref: "ipfs://…" }
```

---

## Provisioning

### Quick path — cloud-init (any provider)

[`cloud-init/user-data.yaml`](cloud-init/user-data.yaml) installs Docker, opens
the firewall (22/80/443 + swarm 4001/6881), and brings the stack up if
`deploy/.env` is present. Paste it as the server's **user-data** at create time,
then upload `deploy/` + your `.env` and `docker compose up -d`.

### Hetzner Cloud

- **Size:** `cpx21` (3 vCPU / 4 GB / 80 GB NVMe, ~€8/mo) is a comfortable start;
  `cpx11` (2 vCPU / 2 GB) works for light use. IPFS is the memory-hungry piece.
- **Durable storage:** attach a **Volume** (e.g. 50 GB, ~€2.4/mo) and mount it at
  `/var/lib/docker` (uncomment the `mounts:` block in the cloud-init) so named
  volumes survive a server rebuild. Device is typically `/dev/sdb`.
- **Firewall:** use a Hetzner Cloud Firewall (or the ufw rules the cloud-init
  sets): allow 22, 80, 443, 4001, 6881; deny the rest.

### DigitalOcean

- **Size:** `s-2vcpu-4gb` (~$24/mo) is the comfortable start; `s-1vcpu-2gb`
  (~$12/mo) for light use.
- **Durable storage:** attach a **Block Storage Volume** (e.g. 50 GB, $5/mo) and
  mount at `/var/lib/docker`. Device is `/dev/disk/by-id/scsi-0DO_Volume_<name>`.
- **Firewall:** a DigitalOcean Cloud Firewall with inbound 22/80/443/4001/6881.

### Terraform (optional)

[`terraform/`](terraform/) is a skeleton that provisions either target + a data
volume and injects the cloud-init. Tokens come from the environment:

```bash
cd deploy/terraform
export TF_VAR_hcloud_token=…           # or TF_VAR_do_token=…
terraform init
terraform apply -var="target=hetzner" -var="ssh_key_name=my-key"
```

---

## Backup / restore

All durable state is in named volumes. Back up `ipfs-data` (pinned blocks),
`seed-data` (seeded files + the magnets they back), `control-data` (jobId→ref
map), and `caddy-data` (TLS certs).

```bash
# Back up every volume to ./backups (stop for a fully consistent IPFS repo).
mkdir -p backups
for v in ipfs-data seed-data control-data caddy-data; do
  docker run --rm -v p2present-persist_$v:/v -v "$PWD/backups":/b alpine \
    tar czf /b/$v.tar.gz -C /v .
done

# Restore into a fresh host (volumes recreated by `compose up` first, then):
for v in ipfs-data seed-data control-data caddy-data; do
  docker run --rm -v p2present-persist_$v:/v -v "$PWD/backups":/b alpine \
    sh -c "rm -rf /v/* && tar xzf /b/$v.tar.gz -C /v"
done
docker compose up -d
```

The volume prefix is the compose project name (`p2present-persist` — set by
`name:` in `docker-compose.yml`); confirm with `docker volume ls`. The seed
service **re-seeds everything in `seed-data` on boot**, so magnets resume after a
restore; IPFS keeps serving any CID whose blocks are in `ipfs-data`.

> **Durability caveat:** content lives as long as *this* node serves it. For
> stronger guarantees, pin CIDs to a second node / managed pinning service, seed
> from more than one box, or use Arweave (`ar://`, genuinely pay-once permanent)
> for the assets that must outlive the host. Arweave is the only one of these
> that does not depend on you keeping a server up.

---

## Cost notes (rough, mid-2026)

| | Hetzner Cloud | DigitalOcean |
|---|---|---|
| Compute (start) | cpx21 3 vCPU/4 GB ≈ **€8/mo** | s-2vcpu-4gb ≈ **$24/mo** |
| Compute (light) | cpx11 2 vCPU/2 GB ≈ **€4/mo** | s-1vcpu-2gb ≈ **$12/mo** |
| Block volume 50 GB | ≈ **€2.4/mo** | **$5/mo** |
| Egress | 20 TB included | 1–4 TB included, then $0.01/GB |
| TLS | free (Let's Encrypt via Caddy) | free |

Hetzner is materially cheaper for the same specs and includes far more egress —
relevant because seeding + gateway serving is bandwidth-heavy. DigitalOcean has
more regions and a slicker API. Both run this stack identically.

---

## Files

```
deploy/
  docker-compose.yml      the stack (control · seed · ipfs · caddy) + named volumes
  .env.example            copy → .env (secrets/domains); .env is gitignored
  control/                control API the Worker calls (Node built-ins, no deps)
    server.mjs  Dockerfile  package.json
  seed/                   always-on WebTorrent seeder (Node + webtorrent)
    server.mjs  Dockerfile  package.json
  caddy/Caddyfile         TLS reverse proxy (auto Let's Encrypt)
  cloud-init/user-data.yaml   installs Docker + firewall + brings the stack up
  terraform/              optional Hetzner/DigitalOcean provisioning skeleton
```
