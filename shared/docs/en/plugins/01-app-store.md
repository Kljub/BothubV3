---
title: The App Store
summary: Install plugins, allow what they may do, switch them on per bot.
---
Plugins add commands and features: games, AI chat, image generation, Plex, server backups and more. They come from the **BotHub Marketplace**.

## Install

Open the **App Store** in the user menu. Every plugin shows its description, version, commands and the **SDK permissions** it needs. Click **Install**. Updates show up there too.

## Allow what it may do

A plugin runs in a sandbox and can do only what the admin allows under **Admin → SDK Policies**: send messages, read members, manage roles, use the economy, use secrets, and so on. A plugin whose permissions are not allowed shows *Disabled* and the missing permissions.

## Switch it on per bot

Under **Plugins** in the sidebar switch the plugin on for the bot. Its page shows:

- its **settings**,
- its **commands**: switch them on; each has **Public** / **Only me** for who sees the answers,
- files it stored (e.g. backups) to download.

## Keys

Plugins that use external services (AI Chat, ArcEnCiel, Plex, Forge, Weather, …) need [secrets](/docs/plugins/secrets).
