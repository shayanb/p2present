# deploy/terraform/variables.tf — inputs for the provisioning skeleton.
# Secrets (tokens) come from the environment (TF_VAR_*), never committed.

variable "target" {
  description = "Which cloud to provision: hetzner | digitalocean"
  type        = string
  validation {
    condition     = contains(["hetzner", "digitalocean"], var.target)
    error_message = "target must be \"hetzner\" or \"digitalocean\"."
  }
}

variable "hostname" {
  description = "Server / droplet name"
  type        = string
  default     = "p2present-persist"
}

variable "ssh_key_name" {
  description = "Name of an SSH key already registered in the cloud account"
  type        = string
}

variable "volume_size_gb" {
  description = "Durable block-storage size (GiB) for the named volumes"
  type        = number
  default     = 50
}

# --- Hetzner ----------------------------------------------------------------
variable "hcloud_token" {
  description = "Hetzner Cloud API token (set via TF_VAR_hcloud_token)"
  type        = string
  default     = ""
  sensitive   = true
}
variable "hetzner_server_type" {
  description = "Hetzner server type"
  type        = string
  default     = "cpx21" # 3 vCPU / 4 GB / 80 GB — ~€8/mo
}
variable "hetzner_location" {
  description = "Hetzner location (nbg1/fsn1/hel1/ash/hil)"
  type        = string
  default     = "nbg1"
}

# --- DigitalOcean -----------------------------------------------------------
variable "do_token" {
  description = "DigitalOcean API token (set via TF_VAR_do_token)"
  type        = string
  default     = ""
  sensitive   = true
}
variable "do_droplet_size" {
  description = "DigitalOcean droplet size slug"
  type        = string
  default     = "s-2vcpu-4gb" # ~$24/mo
}
variable "do_region" {
  description = "DigitalOcean region (nyc3/ams3/sfo3/sgp1…)"
  type        = string
  default     = "ams3"
}
