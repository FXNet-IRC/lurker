<h1>
  <img src="docs/assets/lurker-icon.png" alt="" width="48" height="48" align="top">&nbsp;&nbsp;Lurker
</h1>

[![CI](https://github.com/amiantos/lurker/actions/workflows/test.yml/badge.svg)](https://github.com/amiantos/lurker/actions/workflows/test.yml)
[![Docker image](https://github.com/amiantos/lurker/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/amiantos/lurker/pkgs/container/lurker)
[![codecov](https://codecov.io/github/amiantos/lurker/graph/badge.svg?token=2KAFLPWKHG)](https://codecov.io/github/amiantos/lurker)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/amiantos/lurker/badge)](https://scorecard.dev/viewer/?uri=github.com/amiantos/lurker)
[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](LICENSE)
[![IRC: #lurker](https://img.shields.io/badge/IRC-%23lurker%20on%20Libera.Chat-1459b8)](https://web.libera.chat/#lurker)

Lurker is a beautiful self-hosted IRC client with a retro aesthetic and modern conveniences.

# Features

- **Always-on and multi-user.** Each invited user connects to their own set of IRC networks, and Lurker stays connected when they're away. Admins can restrict which networks users can connect to, and make channel recommendations for newcomers.
- **Fully working search.** Search your message history, filter by nick, channel, or network; and jump to any message instantly, no matter how old it is.
- **Modern conveniences.** Peer presence, automatic nick regain, join/part summarization, tab nickname completion, message drafts, saved messages, user notes, and more.
- **Image uploads.** Paste an image into the input box, and Lurker optimizes it, sanitizes it, and uploads it to local storage, S3, Zipline, Chibisafe, or external services like x0.at or catbox.moe.
- **Customizable UI.** The beautiful retro terminal-style PWA interface has 40+ settings to customize it how you want.
- **Native Apps.** Lurker has official native apps [for iOS](https://github.com/amiantos/lurker-ios) (in beta) and Android (coming soon). There's also third party clients like [Spooky](https://github.com/JawshTheDark/lurker-android-upstream) (Android) and [Scully](https://github.com/JawshTheDark/scully) (PC).
- **Built-in soju-compatible bouncer.** Don't want to use the Lurker clients? Then don't. Lurker has a ZNC and soju-compatible bouncer built in, complete with `soju.im/bouncer-networks` support so you can use any client you want.

# Screenshot (PWA)

<img src="docs/assets/screenshot.png" alt="Lurker IRC client screenshot" width="100%">

# Screenshot (iOS)

<img src="docs/assets/ios-screenshots.png" alt="Lurker IRC client screenshot on iOS" width="100%">

# Rave Reviews

- `<cfuser> amiantos: holy shit, you made something better than irccloud`
- `<amigojapan> great, now that amiantos's chat client is catching up to IRC cloud, I think I can switch to it as my daily driver`
- `<skdoo> amiantos makes cool shit`
- `<jadeia> lurker is really nice. this is streets ahead of irccloud in terms of design and ease of use.`
- `<helsinski> Lurker iOS is certainly shaping up to be real good.`
- `<quark> These days I am only using Lurker. Desktop and mobile.`

# Installation

## Install (Docker - Recommended)

```bash
curl -O https://raw.githubusercontent.com/amiantos/lurker/main/docker-compose.yml
docker compose up -d
```

Then open <http://localhost:8015> and create your admin account. See [SELF_HOSTING.md](docs/SELF_HOSTING.md) for the full guide.

## Manual Install

```bash
npm run install:all
npm run client:build
npm start
```

## Lurker.Chat Managed Hosting

Don't want to run a server yourself? **[Lurker.Chat](https://lurker.chat)** is official managed hosting — **$5/mo**, with a 14-day money-back guarantee.

# Documentation

- [https://docs.lurker.chat](https://docs.lurker.chat)

# Community

- Chat in **#lurker** on [Libera.Chat](https://libera.chat).

# License

Mozilla Public License 2.0 — see [LICENSE](LICENSE).
