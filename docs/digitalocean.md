# Deploy Lurker on DigitalOcean (one-shot)

Stand up a public, HTTPS-enabled Lurker on a fresh DigitalOcean droplet from a single pasted script — no SSH required.

[![Watch the Lurker DigitalOcean deployment walkthrough](assets/yt-tutorial-thumb.png)](https://youtu.be/L730O7KNGlA)

## Steps

1. Create a droplet — the Docker Marketplace image at the smallest size is fine (vanilla Ubuntu 24.04 LTS works too).
2. At droplet creation, expand **Additional Options** and enable **User Scripts** (DigitalOcean's label for cloud-init user data — older guides call it "User data" or "Startup scripts"). Paste in the contents of [`deploy/digitalocean-cloud-init.sh`](../deploy/digitalocean-cloud-init.sh), after filling in the two required values near the top of the script — `LURKER_DOMAIN` (your domain, e.g. `irc.yourdomain.com`) and `ADMIN_EMAIL` (your email address).
3. Once the droplet exists, copy its public IP and add a DNS `A` record pointing your domain at it.
4. Give it a few minutes, then visit your domain.

You don't need the droplet's IP before creating it: the droplet boots and starts Caddy _before_ DNS exists, and Caddy keeps retrying Let's Encrypt until your `A` record resolves — so HTTPS comes up automatically a few minutes after you set the DNS record. (If you'd rather the certificate be ready the moment the droplet boots, reserve a [Reserved IP](https://docs.digitalocean.com/products/networking/reserved-ips/) first, point DNS at it, then create the droplet and assign that Reserved IP.)

Passkeys and web push notifications are configured automatically — the deploy derives the WebAuthn and push settings from your domain and email — so you can enable them per device from Lurker's in-app settings without touching the server.

**IRC runs in the engine, and ident is answered.** Both are on from the first boot here, and neither is a knob you have to find:

- The **IRC engine** (`lurker-engine`) holds the IRC sockets in a container that an app upgrade never recreates, so `docker compose pull && up -d` replaces Lurker without re-registering, re-identifying, rejoining, or showing everyone in your channels a `Quit`/`Join`. It holds no data. There is nothing to migrate to later — unlike a plain self-host, which stays a two-command install and [adds the engine when it wants it](/MIGRATION_ENGINE). An **engine** upgrade does still drop IRC; those releases say so in their notes.
- **identd** answers on `:113` from the engine — it is the process holding the socket the network asks about, so it is the only one that can. Users get a verified ident instead of a shared `~ident`, which is what networks like Libera ask of a hosted service. Set `ENABLE_IDENTD=""` in the script if you would rather not run it.

Check what the engine is holding at any time:

```bash
cd /opt/lurker
docker compose exec lurker \
  node -e "require('http').get('http://lurker-engine:8016/healthz',r=>r.pipe(process.stdout))"
```

Deploy progress is logged to `/var/log/lurker-deploy.log` on the droplet.

## Optional extras

One feature is off unless you switch it on in the script, next to the two required values:

- **`ENABLE_LINK_PREVIEWS="true"`** — runs [`lurker-previews`](https://github.com/amiantos/lurker-previews), the second container that turns pasted links into preview cards, renders images inline, and gives videos a poster frame.

(The engine and identd are covered above — both are on by default here, and identd is the one you turn _off_, with `ENABLE_IDENTD=""`.)

Link previews are worth a word on what the script does for you, because it is the part that is fiddly by hand. All the fetching and media parsing happens in that second container, never in the one holding your database and sessions — and the script gives it the same treatment the hosted fleet gets: its own private bridge, firewall rules that let it reach the public internet and nothing private (not this droplet, not your VPC, not your other containers), and a systemd unit that re-applies them on every boot. The decoder's own boot self-test is left on, so it re-proves that containment every time it starts and refuses to serve rather than quietly parse hostile bytes with a route to your infrastructure — the one lapse it can't catch by itself is a firewall reload while it's running, which is why the note below the update command exists.

The deploy also turns on the preview byte cache (`local`, a 2 GiB least-recently-used directory inside `data/`). That is not a tuning choice: **video posters require a cache**, because a poster is the one preview image with no origin URL — the decoder makes those bytes out of the video itself, so with nowhere to store them the server never asks for one and video links render as bare cards. It's a cache and not data; deleting it while the server is stopped costs nothing but a re-fetch.

Budget the RAM: the decoder is capped at 512 MB and ffmpeg will use it when it makes a poster. On the smallest 1 GB droplet it leans on swap; 2 GB is comfortable. And enabling it here only opens the door — each user still turns on **Link previews** and **Inline media** in **Settings → Chat**, both off by default.

## Updating

SSH in (or open the DigitalOcean web console) and run:

```bash
cd /opt/lurker
docker compose pull && docker compose up -d
```

The deploy script records every overlay it used — Caddy, the engine, identd — in `COMPOSE_FILE` in `.env`, so `docker compose` picks them all up automatically and no `-f` flags are needed. Your `data/` directory is left untouched, and this upgrade replaces only the app: **your IRC connections stay up.**

If you enabled link previews, follow that with:

```bash
sudo /opt/lurker/previews-egress.sh
```

The firewall rules are scoped to the address Docker gave the decoder, and updating it can hand it a new one. Re-running is idempotent and takes seconds. You will not have to remember for updates: a decoder whose rules no longer fit refuses to serve and says so in `docker logs lurker-previews`, previews go blank, and nothing else is affected.

⚠ Run it again after changing the firewall too — `ufw allow …` reloads the ruleset and drops the rule that keeps the droplet itself unreachable from the decoder. That one is _not_ self-announcing, because the decoder only re-checks its containment when it starts. Reboots and Docker restarts are already handled by the systemd unit the script installs.

## Going further

For backups, admin-password recovery, and other operational details, see the [self-hosting guide](SELF_HOSTING.md).
