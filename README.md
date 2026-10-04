# BotHub

A self-hosted dashboard for your own Discord bots. You bring the bot (a
Discord application and its token); BotHub runs it and gives it modules,
commands and plugins that you switch on and set up in the browser, without
writing code.

## Features

- **Several bots** in one dashboard, each with overview statistics, status
  and presence, servers, logs and settings.
- **Modules** ready to switch on: moderation and AutoMod, tickets and
  modmail, leveling, economy with currencies, bank, lottery and shop,
  welcome and leave messages, reaction roles, verification, polls,
  suggestions, starboard, birthdays, social notifications (Twitch, Kick,
  YouTube, Reddit, GitHub), free games, temp voice channels and more.
- **Builders**: Command Builder (slash commands from blocks), custom and
  timed events, Data Storage variables, Message Builder (embeds,
  components V2), Card Designer, webhooks.
- **Plugins** from the [BotHub Marketplace](https://github.com/Kljub/BothubMarketPlace):
  installed through the App Store, run in a sandbox and allowed per
  permission (SDK policies). Their keys live in per-user secrets the plugin
  never sees.
- **Accounts**: several users with roles, two-factor sign-in (TOTP),
  recovery codes and passkeys; **Co-Work** lets other users work on a bot
  with a role (viewer, operator, builder, admin or custom rights).
- **Docs** inside the dashboard (`/docs`), English and German, with a page
  for every module, and a guided **Start Tour**.
- Public **Terms** and **Privacy** pages for Discord's app verification.

## Architecture

| Service | Language | Job |
|---|---|---|
| `dashboard` | Go | Web UI (htmx), the only public port |
| `mockapi` | Go | Gateway in front of the API: sign-in, sessions, 2FA, passkeys, per-bot access |
| `api` | PHP (FrankenPHP) | REST API on SQLite, migrations, plugin store |
| `relay` | PHP | Moves events from the database outbox to Redis |
| `bot` | Node (TypeScript, discord.js) | Runs every bot, the modules and the plugin sandbox |
| `redis` | | Events between API and bot, cache |

All data lives in `./data` (SQLite database, Redis, plugins, uploads). The
services find each other only through environment variables.

## Quick start

Requirements: Docker with Docker Compose.

1. Copy the example settings and fill them in:

   ```
   cp .env.example .env
   ```

   | Variable | Meaning |
   |---|---|
   | `DASHBOARD_PORT` | Port of the dashboard (default 8080) |
   | `BOTHUB_INTERNAL_KEY` | Shared secret of the services, at least 32 characters (`openssl rand -hex 32`) |
   | `COMPOSE_PROFILES=mock` and `API_URL=http://mockapi:9000` | Start the gateway (needed for sign-in) |
   | `BOTHUB_ADMIN_USER`, `BOTHUB_ADMIN_PASSWORD` | Optional first admin; otherwise the setup wizard asks |
   | `BOTHUB_DEFAULT_LOCALE` | `en` or `de` |
   | `TZ` | Time zone, e.g. `Europe/Berlin` |
   | `WEBAUTHN_RP_ID` | Domain for passkeys (default `localhost`) |

   `BOTHUB_ADMIN_PASSWORD` may be plain text or an Argon2id hash. Admins see
   a warning while it is plain text. Make a hash with
   `docker compose exec mockapi app hash-password "<password>"` and put it in
   single quotes: `BOTHUB_ADMIN_PASSWORD='$argon2id$…'`.

2. Start everything:

   ```
   docker compose up -d --build
   ```

3. Open `http://localhost:8080` (or your `DASHBOARD_PORT`), sign in, and
   follow **Docs → Getting started → Add your first bot**.

## Discord bot setup in short

In the [Developer Portal](https://discord.com/developers/applications):
create an application, copy the bot token, and switch on the **Server
Members**, **Presence** and **Message Content** intents. Add the token in
BotHub (bot switch → *Add bot*) and use **Invite Bot** to add it to your
server. From 75 servers on, Discord's app verification applies; the docs
have a guide.

## Updating

```
git pull
docker compose up -d --build
```

The API migrates the database on start; the bot starts once the database
has its schema version. Back up `./data` before larger updates.

## Development

| Part | Tests |
|---|---|
| Bot | `cd bot && npm test` |
| Dashboard and gateway | `cd dashboard && go test ./...` (Go 1.27) |
| API | `docker run --rm -v "$PWD/api:/app" -v "$PWD/shared:/shared" bothub-api sh -c 'for t in tests/*.php; do php $t; done'` |
| Plugins | `cd sdk/market && npm run check` (needs the marketplace repo next to this one) |

Repository layout:

```
api/         PHP API: src/, migrations/, tests/
bot/         Node bot core, modules, plugin manager (SDK host)
dashboard/   Go dashboard (internal/web, ui/templates, ui/static) and gateway (cmd/mockapi)
sdk/         Plugin SDK types, test kit, API.md, market tools
shared/      Shared definitions: modules, commands, presets, nodes, settings schemas, docs
data/        Runtime data (not in git)
```

Shared definitions in `shared/` are read by all services: node and command
definitions, module settings schemas, the SDK permission list and the
shipped docs (`shared/docs`, Markdown in English and German).

## Plugins

Plugins come from the [BotHub Marketplace](https://github.com/Kljub/BothubMarketPlace).
To write your own, see **Docs → Plugins & SDK → Develop a plugin** and
`sdk/API.md`.
