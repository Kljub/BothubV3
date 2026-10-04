---
title: Secrets for plugins
summary: Keys and addresses that plugins use without ever seeing them.
---
Secrets live under **Settings → API / Secrets** (user menu).

## How it works

1. When a plugin is installed, it creates its secrets empty, e.g. `PLEX_URL` and `PLEX_TOKEN`.
2. You enter the value and switch the secret **on for the plugin**.
3. When the plugin calls its service, it names the secret. The bot adds the value to the request and masks it in the answer. The plugin's code never sees it.

## Good to know

- Secrets belong to one user. A bot uses the secrets of its owner.
- **Addresses** (`…_URL`) may be in your home network. **Keys** are sent only to the hosts the plugin declared.
- A secret a plugin can do without (e.g. Overseerr for Plex, the login of Forge) stays switched off when you do not use it.
- Some services have a **sign in** button instead (e.g. *Sign in with Plex*) that fills the secrets for you.
