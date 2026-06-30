# deploy/terraform/main.tf — OPTIONAL skeleton to provision the persistence host
# on EITHER Hetzner Cloud or DigitalOcean. Nothing here is applied for you and no
# credentials are committed — set the API token via the environment, pick a
# target with -var="target=hetzner|digitalocean", and run plan/apply yourself.
#
#   export TF_VAR_hcloud_token=…     # or TF_VAR_do_token=…
#   terraform init
#   terraform plan  -var="target=hetzner" -var="ssh_key_name=my-key"
#   terraform apply -var="target=hetzner" -var="ssh_key_name=my-key"
#
# Both branches inject deploy/cloud-init/user-data.yaml as user-data, so the host
# installs Docker + opens the firewall on boot (see that file). A block-storage
# volume is attached for durable named-volume storage.

terraform {
  required_version = ">= 1.5"
  required_providers {
    hcloud       = { source = "hetznercloud/hcloud", version = "~> 1.48" }
    digitalocean = { source = "digitalocean/digitalocean", version = "~> 2.40" }
  }
}

locals {
  is_hetzner = var.target == "hetzner"
  is_do      = var.target == "digitalocean"
  user_data  = file("${path.module}/../cloud-init/user-data.yaml")
}

# === Hetzner Cloud ==========================================================
provider "hcloud" {
  token = var.hcloud_token
}

resource "hcloud_server" "p2present" {
  count       = local.is_hetzner ? 1 : 0
  name        = var.hostname
  server_type = var.hetzner_server_type # cpx21 = 3 vCPU / 4 GB — a good start
  image       = "ubuntu-24.04"
  location    = var.hetzner_location     # e.g. nbg1, fsn1, hel1, ash
  ssh_keys    = [var.ssh_key_name]
  user_data   = local.user_data
}

resource "hcloud_volume" "data" {
  count     = local.is_hetzner ? 1 : 0
  name      = "${var.hostname}-data"
  size      = var.volume_size_gb # GiB of durable storage for ipfs/seed/caddy data
  server_id = hcloud_server.p2present[0].id
  automount = false              # mount at /var/lib/docker via cloud-init (see notes)
}

# === DigitalOcean ===========================================================
provider "digitalocean" {
  token = var.do_token
}

resource "digitalocean_droplet" "p2present" {
  count     = local.is_do ? 1 : 0
  name      = var.hostname
  region    = var.do_region        # e.g. nyc3, ams3, sfo3
  size      = var.do_droplet_size  # s-2vcpu-4gb — a good start
  image     = "ubuntu-24-04-x64"
  ssh_keys  = [var.ssh_key_name]
  user_data = local.user_data
}

resource "digitalocean_volume" "data" {
  count       = local.is_do ? 1 : 0
  name        = "${var.hostname}-data"
  region      = var.do_region
  size        = var.volume_size_gb
  description = "p2present persistence (ipfs/seed/caddy named volumes)"
}

resource "digitalocean_volume_attachment" "data" {
  count      = local.is_do ? 1 : 0
  droplet_id = digitalocean_droplet.p2present[0].id
  volume_id  = digitalocean_volume.data[0].id
}

output "host_ipv4" {
  value = local.is_hetzner ? try(hcloud_server.p2present[0].ipv4_address, null) : try(digitalocean_droplet.p2present[0].ipv4_address, null)
}
