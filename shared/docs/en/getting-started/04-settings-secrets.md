---
title: Your settings and API / Secrets
summary: Language, design, account, two-factor sign-in and your own keys.
---
Open the **user menu** at the bottom left and choose **Settings**.

## General

- **Language** of the dashboard (also the globe at the top right). It applies to you only.
- **Theme**: system, light or dark.

## Account and security

- Username, email and password.
- **Two-factor sign-in** with an authenticator app, and passkeys.

## API / Secrets

Plugins and some modules need keys or addresses: an OpenAI key for AI Chat, the address and token of your Plex server, the address of your Stable Diffusion Forge server, and so on. They are **secrets**:

- Every user has their own secrets. Other users never see or use them.
- A bot uses the secrets of **its owner**.
- A plugin never sees a secret. It names it, and the bot adds the value to the request.
- A secret is used only by plugins you **switched it on for** (the switch next to the plugin).

When you install a plugin, its secrets are created empty (*[NULL]*). Enter the value, switch it on for the plugin, done. A secret you do not need (an optional one) you just leave switched off.

> [!TIP]
> Addresses may point into your home network (e.g. `http://192.168.1.20:7860`), keys go only to the hosts the plugin declared.

## Admin area

Users with admin rights also find the **admin area** in the user menu: resource overview, users and roles, server logs, **SDK Policies** (what plugins may do), server settings, invite policies, email and the instance secrets (e.g. the token for the BotHub Marketplace).
