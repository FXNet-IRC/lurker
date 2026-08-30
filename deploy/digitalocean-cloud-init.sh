#!/bin/bash
# Copyright (c) 2026 Brad Root
# SPDX-License-Identifier: MPL-2.0
#
# Lurker — DigitalOcean one-shot deploy (cloud-init user-data)
# ============================================================
#
# Paste the ENTIRE contents of this file into the "User Scripts" field when
# creating a DigitalOcean droplet (under "Additional Options"). That field is
# DigitalOcean's label for cloud-init user data; older guides call it "User
# data" or "Startup scripts". On first boot the droplet will, with no SSH:
#
#   * install Docker + the Compose plugin (skipped if already present, so
#     this works on both the Docker Marketplace image and vanilla Ubuntu)
#   * fetch Lurker, front it with Caddy for automatic HTTPS (Let's Encrypt),
#     and start everything under Docker Compose
#   * run the IRC engine, so upgrading Lurker never drops your IRC connections
#   * answer ident on :113, so networks see a verified ident for each user
#   * configure passkeys and web push — HTTPS makes both possible, so the
#     instance comes up feature-complete with no post-install server admin
#   * add a small swapfile on low-RAM droplets and configure the firewall
#
# Everything is logged to /var/log/lurker-deploy.log — view that from the
# DigitalOcean droplet console if a deploy doesn't come up as expected.
#
# ─── Required: fill in BOTH values before pasting ───────────────────────────
#
# This deploy always serves Lurker over HTTPS. HTTPS isn't a nicety here — it
# is what makes passkeys, web push, and secure browser sessions work — so
# there is no plain-HTTP option, and both values below are required. The
# script aborts if either is left blank.

# The public domain Lurker will be served on, e.g. "irc.example.com".
# Caddy obtains a Let's Encrypt certificate for it automatically. Once the
# droplet exists, point a DNS A record for this domain at the droplet's IP
# (the deploy log prints it); Caddy keeps retrying until that record resolves.
LURKER_DOMAIN=""

# Your email address. It is used for two things, both of which need a real,
# reachable address: the Let's Encrypt certificate contact (renewal and
# expiry notices), and the contact embedded in web-push messages, which
# Apple, Google, and Mozilla's push services require.
ADMIN_EMAIL=""

# ─── Built-in identd (RFC 1413) — ON by default ─────────────────────────────
#
# This is a public, domain-having instance, so it is set up the way a hosted
# service is expected to be: identd answers on :113, and IRC networks attribute
# each user individually behind the shared droplet IP (which is what networks
# like Libera ask of a hosted service). Users appear with a verified ident
# rather than an unverified "~ident". The script publishes :113 and opens it in
# the firewall.
#
# Set this to "" to turn it off — a single-user instance does not need it, and
# a network that never asks will not notice either way.
#
# ⚠ identd runs on the ENGINE, not on `lurker`: it is the process holding the
# IRC socket the network asks about, so it is the only one that can answer.
# The script wires it there for you.
#
# Docker note: the :113 callback is matched against the full connection 4-tuple
# (both addresses + both ports), so the container has to see the IRC server's
# real source IP and the outbound connection's source port. Docker's default
# bridge (iptables DNAT) preserves both for external callbacks, so this works
# as-is. If you ever see unverified idents — under heavy concurrency (source-port
# reuse), or if your host routes :113 through the userland proxy so callbacks
# appear to come from the docker gateway — run the `lurker-engine` service with
# `network_mode: host` instead, so the container shares the host's addresses
# directly. The engine logs `[identd] <ports> matched a live connection but
# query address <ip> did not` on every such mismatch, which is the signal to
# switch.
ENABLE_IDENTD="true"

# ─── Optional: link previews & inline media ─────────────────────────────────
#
# Set to "true" to also run `lurker-previews`, the decoder that makes pasted
# links unfurl into cards, images render inline, and videos show a poster
# frame. It is a SECOND container by design: it does all the fetching and all
# the media parsing, so the container holding your database and your users'
# sessions never dials a URL a stranger chose.
#
# Off by default because it makes your droplet fetch third-party URLs that
# appear in chat — your bandwidth and your IP's reputation, so it should be a
# decision. Turning it on here only enables it for the INSTANCE; each user
# still opts in under Settings → Chat, where both switches also default to off.
#
# This script gives the decoder the full hosted-fleet treatment rather than the
# relaxed self-host one: a private bridge of its own, iptables rules that let it
# reach the public internet and nothing private (not the VPC, not your other
# containers, not this droplet), a systemd unit that re-applies them on every
# boot, and the decoder's own boot self-test left ON — so if the containment
# ever lapses it refuses to serve instead of quietly parsing hostile bytes with
# a route to your infrastructure.
#
# ⚠ Budget RAM for it: the decoder is capped at 512 MB and ffmpeg uses that
# ceiling when it decodes a poster. On the smallest (1 GB) droplet it will lean
# on swap; 2 GB is the comfortable size once this is on.
ENABLE_LINK_PREVIEWS=""

# ─── The IRC engine — always on here, and not a knob ────────────────────────
#
# Lurker's IRC sockets live in a second container (`lurker-engine`) that an app
# upgrade never recreates, so `docker compose pull && up -d` replaces Lurker
# without re-registering, re-identifying, rejoining, or showing everyone in your
# channels a Quit/Join. It holds no data — no database, no uploads, no volumes.
#
# This deploy uses it from the first boot, so there is nothing to migrate to
# later. That is deliberately unlike the self-host quickstart, which stays a
# two-command install and treats the engine as something you add when you want
# it (docs/MIGRATION_ENGINE.md). Here the droplet is long-lived and public, and
# not dropping IRC on every upgrade is worth a second container.
#
# The shared secret both containers authenticate with is generated below and
# written to /opt/lurker/.env. It is preserved across a re-run of this script:
# changing it would recreate the engine, which is the one thing it exists to
# avoid. The engine publishes no port — :8016 exists only on the compose
# network — so nothing here is reachable from outside the droplet.
#
# ⚠ An ENGINE upgrade still drops IRC. Its tag is `engine-1`, which moves only
# when a release changes the engine; those releases say so in their notes.

# ─── No edits needed below this line ────────────────────────────────────────

set -euo pipefail

# The branch or tag every file below is fetched from. `main` is what an operator
# wants, and what cloud-init gets when this is pasted unedited.
#
# ⚠ It is a knob because a change to THIS script cannot otherwise be tested
# before it is merged: everything comes from raw.githubusercontent, so a file a
# branch ADDS 404s here until it lands on main, and the deploy dies at the curl.
# Point this at the branch to test one — `LURKER_REPO_REF=my-branch bash
# digitalocean-cloud-init.sh` works too, for a re-run on a droplet by hand.
REPO_REF="${LURKER_REPO_REF:-main}"
REPO_RAW="https://raw.githubusercontent.com/amiantos/lurker/${REPO_REF}"
INSTALL_DIR="/opt/lurker"
DEPLOY_LOG="/var/log/lurker-deploy.log"

# cloud-init runs headless, so mirror all output into a log file that can be
# read back later from the droplet console.
exec > >(tee -a "$DEPLOY_LOG") 2>&1

log() { echo "[lurker-deploy $(date -u +%H:%M:%S)] $*"; }

log "=== Lurker deploy started $(date -u +%FT%TZ) ==="
# Say it once, up front: a deploy fetching from somewhere other than main is a
# test of an unmerged change, and the log is the only place that fact survives.
if [ "$REPO_REF" != "main" ]; then
  log "⚠ Fetching from ref '${REPO_REF}', NOT main — this is a branch test."
fi

# Both settings are mandatory. Fail early and loudly — before installing
# anything — rather than half-deploying; the log is the only place this
# message will surface, since cloud-init runs with no console.
require_config() {
  local missing=0
  if [ -z "$LURKER_DOMAIN" ]; then
    log "ERROR: LURKER_DOMAIN is empty — set it near the top of this script."
    missing=1
  fi
  if [ -z "$ADMIN_EMAIL" ]; then
    log "ERROR: ADMIN_EMAIL is empty — set it near the top of this script."
    missing=1
  fi
  if [ "$missing" -ne 0 ]; then
    log "Aborting: LURKER_DOMAIN and ADMIN_EMAIL are both required."
    exit 1
  fi
}

# ── Prerequisites ───────────────────────────────────────────────────────────

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then
    return
  fi
  log "Installing curl..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl ca-certificates
}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    log "Docker already installed ($(docker --version)) — skipping install."
    return
  fi
  log "Docker not found — installing via the official convenience script."
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
  systemctl enable --now docker
}

# On the Docker Marketplace image the daemon may still be settling when
# cloud-init runs; wait for it rather than assuming the socket is ready.
wait_for_docker() {
  log "Waiting for the Docker daemon..."
  local i
  for i in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then
      log "Docker daemon is ready."
      return
    fi
    sleep 2
  done
  log "ERROR: Docker daemon did not become ready within 60s."
  exit 1
}

# Prefer the Compose v2 plugin; fall back to the legacy v1 binary for older
# images. Every compose invocation below goes through this wrapper.
compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
  else
    log "ERROR: no Docker Compose (v2 plugin or v1 binary) found."
    exit 1
  fi
}

# ── Host setup ──────────────────────────────────────────────────────────────

# The cheapest droplets ship 512MB–1GB of RAM; a small swapfile keeps the
# image pull and Node runtime comfortable.
ensure_swap() {
  local mem_kb
  mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  if [ "$mem_kb" -ge 2000000 ]; then
    log "RAM is $((mem_kb / 1024))MB (>= 2GB) — no swapfile needed."
    return
  fi
  if swapon --show 2>/dev/null | grep -q .; then
    log "Swap already active — leaving it alone."
    return
  fi
  log "RAM is $((mem_kb / 1024))MB (< 2GB) — adding a 1GB swapfile."
  fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
}

# UFW: open SSH *first* so a bad rule can't lock us out, then HTTP/HTTPS for
# Caddy. Lurker's own 8015 is never published on the host (the Caddy overlay
# drops that binding), so it stays internal to the Docker network.
#
# Note: Docker publishes container ports straight into iptables, bypassing
# UFW — so the `ufw deny 8015` below is only belt-and-suspenders; the real
# isolation comes from docker-compose.caddy.yml not binding 8015 at all.
configure_firewall() {
  if ! command -v ufw >/dev/null 2>&1; then
    log "ufw not installed — skipping firewall configuration."
    return
  fi
  log "Configuring UFW firewall (SSH allowed first)..."
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw deny 8015/tcp
  if [ "$ENABLE_IDENTD" = "true" ]; then
    # IRC servers connect back to :113 to verify each user's ident.
    ufw allow 113/tcp
  fi
  ufw --force enable
  ufw status verbose || true
}

# ── Deploy ──────────────────────────────────────────────────────────────────

deploy() {
  mkdir -p "$INSTALL_DIR"
  cd "$INSTALL_DIR"

  log "Fetching compose files and Caddyfile..."
  curl -fsSL -o docker-compose.yml "$REPO_RAW/docker-compose.yml"
  curl -fsSL -o docker-compose.caddy.yml "$REPO_RAW/docker-compose.caddy.yml"
  curl -fsSL -o Caddyfile "$REPO_RAW/deploy/Caddyfile"

  local compose_files="docker-compose.yml:docker-compose.caddy.yml"

  # The IRC engine, always — see the note at the top. Fetched (not generated) so
  # a later `pull` + `up -d` keeps whatever the overlay grows, and layered before
  # the identd overlay below, which adds a port to the service this one defines.
  #
  # ⚠ This assumes the app image has engine support, i.e. Lurker >= 2.1.4. It
  # does not check: an older image would ignore LURKER_ENGINE_URL silently and
  # leave identd answering from a container holding no sockets. `latest` is
  # 2.1.4+, so the only way to land there is to pin an older image on purpose.
  log "Fetching the IRC engine overlay."
  curl -fsSL -o docker-compose.engine.yml "$REPO_RAW/docker-compose.engine.yml"
  compose_files="${compose_files}:docker-compose.engine.yml"

  # The link-preview decoder: its own overlay (a second container on a private
  # bridge) plus the script that contains its egress. Both are fetched here so
  # that later `docker compose pull` + `up -d` updates keep the service, and so
  # the egress script is on disk for the systemd unit to re-run at boot.
  if [ "$ENABLE_LINK_PREVIEWS" = "true" ]; then
    log "Link previews enabled — fetching the decoder overlay and egress script."
    curl -fsSL -o docker-compose.previews.yml "$REPO_RAW/docker-compose.previews.yml"
    curl -fsSL -o previews-egress.sh "$REPO_RAW/deploy/previews-egress.sh"
    chmod +x previews-egress.sh
    compose_files="${compose_files}:docker-compose.previews.yml"
  fi

  # identd, on the ENGINE — it holds the IRC socket the network asks about, so
  # it is the only process that can answer the callback. Only the port mapping
  # is generated here; LURKER_IDENTD_* go into .env below, which the engine
  # overlay already forwards to `lurker-engine`. Caddy's `ports: !reset []`
  # applies to `lurker` and never touches this service, so unlike the pre-engine
  # version this overlay no longer has to be ordered after Caddy to survive.
  if [ "$ENABLE_IDENTD" = "true" ]; then
    log "identd enabled — publishing :113 on the engine."
    cat > docker-compose.identd.yml <<'YAML'
services:
  lurker-engine:
    ports:
      - '113:113'
YAML
    compose_files="${compose_files}:docker-compose.identd.yml"
  fi

  # Compose interpolates LURKER_DOMAIN/ADMIN_EMAIL into docker-compose.caddy.yml
  # — Caddy reads them for TLS, Lurker reads them for passkeys and push.
  # COMPOSE_FILE records the overlay stack so plain `docker compose` commands —
  # including future `pull` + `up -d` updates — pick up Caddy (and identd)
  # automatically.
  # ⚠ Preserve an existing engine secret across a re-run of this script. A new
  # value changes `lurker-engine`'s environment, which makes Compose recreate it
  # — dropping every IRC connection, i.e. exactly what the engine is for. A
  # first run has no .env and generates one.
  # `.env` is rewritten from scratch below; keep the old one just long enough to
  # read the engine secret back out of it.
  [ -f .env ] && cp .env .env.bak

  cat > .env <<EOF
LURKER_DOMAIN=${LURKER_DOMAIN}
ADMIN_EMAIL=${ADMIN_EMAIL}
COMPOSE_FILE=${compose_files}
EOF

  # ⚠ Preserve an existing engine secret across a re-run of this script. A new
  # value changes `lurker-engine`'s environment, which makes Compose recreate it
  # — dropping every IRC connection, i.e. exactly what the engine is for.
  local engine_secret=""
  if [ -f .env.bak ]; then
    engine_secret="$(sed -n 's/^LURKER_ENGINE_SECRET=//p' .env.bak | head -1)"
  fi
  if [ -z "$engine_secret" ]; then
    engine_secret="$(openssl rand -hex 32 2>/dev/null ||
      head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    log "Generated a new engine secret."
  else
    log "Reusing the engine secret already in .env."
  fi
  cat >> .env <<EOF
LURKER_ENGINE_SECRET=${engine_secret}
EOF

  # The engine overlay forwards these to `lurker-engine`; the overlay generated
  # above publishes the port.
  if [ "$ENABLE_IDENTD" = "true" ]; then
    cat >> .env <<EOF
LURKER_IDENTD_ENABLED=true
LURKER_IDENTD_PORT=113
EOF
  fi

  rm -f .env.bak

  # ⚠ 0, not unset: the overlay defaults this to 1 (skip the self-test), which
  # is the right default for a self-host on a plain Docker network but the
  # wrong one here — this droplet gets real egress rules a few steps below, so
  # the decoder should check them, and keep checking them on every start.
  if [ "$ENABLE_LINK_PREVIEWS" = "true" ]; then
    echo "LURKER_PREVIEWS_ALLOW_PRIVATE=0" >> .env
    # ⚠ The byte cache is not a tuning knob here — VIDEO POSTERS REQUIRE IT.
    # A poster is the one preview image with no origin URL (the decoder makes
    # it out of the video), so with nowhere to store it the server doesn't ask
    # for one and video links render as bare cards. Since this deploy advertises
    # poster frames, it turns the cache on: a 2 GiB LRU directory inside the
    # ./data volume, which is a cache and not data — safe to delete with the
    # server stopped.
    echo "LURKER_PREVIEW_CACHE_MODE=local" >> .env
    # ⚠ Give the self-test something that is genuinely LISTENING. Its built-in
    # probes are the metadata address and the bridge gateway, and a probe that
    # nothing answers passes whether or not the rules are in force. This
    # droplet's VPC address has sshd on it, and it is exactly the kind of
    # neighbour we never want the decoder to reach — so it is the strongest
    # probe available here. Skipped silently if the droplet has no VPC
    # interface; the built-in probes still run.
    local vpc_ip
    vpc_ip=$(curl -fsS --max-time 5 \
      http://169.254.169.254/metadata/v1/interfaces/private/0/ipv4/address 2>/dev/null || true)
    if [ -n "$vpc_ip" ]; then
      echo "LURKER_PREVIEWS_SELFTEST_TARGETS=${vpc_ip}:22" >> .env
    fi
  fi

  compose pull
  compose up -d
  compose ps
}

# The decoder's containment: iptables rules scoped to its address so it can
# reach the public internet and nothing private, plus a systemd unit that
# re-applies them on boot and whenever Docker restarts. The script verifies its
# own work by restarting the decoder and reading the verdict its boot self-test
# logs — so a failure here is a loud one, in the deploy log, rather than a
# preview service that works while quietly holding a route to this droplet.
contain_previews() {
  [ "$ENABLE_LINK_PREVIEWS" = "true" ] || return 0
  log "Containing the link-preview decoder's egress..."
  if "$INSTALL_DIR/previews-egress.sh" --install; then
    log "Link previews are ready — the decoder is contained and serving."
  else
    # Not fatal to the deploy: Lurker itself is up and everything else works.
    # Previews will report themselves unavailable until this is sorted.
    log "WARNING: the decoder is NOT contained and is refusing to serve, so"
    log "previews will stay blank. Lurker is otherwise fine. Re-run it with:"
    log "  ${INSTALL_DIR}/previews-egress.sh --install"
  fi
}

# ── Run ─────────────────────────────────────────────────────────────────────

require_config
ensure_curl
install_docker
wait_for_docker
ensure_swap
deploy
configure_firewall
# ⚠ AFTER configure_firewall, never before: `ufw --force enable` rewrites the
# filter table wholesale, which would take the decoder's rules with it. The
# decoder is up by now and refusing to serve (its self-test found this droplet
# reachable, correctly); the script below fixes that and restarts it.
contain_previews

PUBLIC_IP=$(curl -fsS --max-time 5 \
  http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address \
  2>/dev/null || echo "this droplet's public IP")

log "=== Lurker deploy finished $(date -u +%FT%TZ) ==="
log "Lurker is running. Point a DNS A record for ${LURKER_DOMAIN} at"
log "${PUBLIC_IP} if you haven't already — Caddy retries Let's Encrypt"
log "until it resolves, then https://${LURKER_DOMAIN} serves over HTTPS."
log "Passkeys and web push are pre-configured; once you've created your"
log "admin account, opt in per device from Lurker's settings."
log "IRC runs through the engine container, so future upgrades —"
log "  cd ${INSTALL_DIR} && docker compose pull && docker compose up -d"
log "replace Lurker without dropping your IRC connections. Check what it holds:"
log "  docker compose exec lurker node -e \"require('http').get('http://lurker-engine:8016/healthz',r=>r.pipe(process.stdout))\""
if [ "$ENABLE_IDENTD" = "true" ]; then
  log "Built-in identd is running on :113 — connect to a network and check that"
  log "your ident shows up verified (no leading ~) via /whois on yourself."
fi
if [ "$ENABLE_LINK_PREVIEWS" = "true" ]; then
  log "Link previews are enabled for the instance, which is only half the gate:"
  log "each user turns on Link previews and Inline media in Settings → Chat."
  log "Decoder health: docker logs lurker-previews"
fi
