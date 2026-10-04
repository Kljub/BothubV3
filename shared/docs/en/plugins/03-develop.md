---
title: Develop a plugin
summary: Structure, SDK, tests and publishing to the Marketplace.
---
A plugin is a folder with a manifest, JavaScript code and texts. It runs in its own process and talks to the bot only through the **SDK** (`ctx`).

## Structure

```
plugin_myplugin/
  bothub.json     manifest: id, version, SDK permissions, commands, nodes, services
  index.js        joins the layers: blocks, components, events, tasks
  nodes/          builder blocks: <name>.json (definition) + <name>.js (handler)
  commands/       slash commands as Command Builder graphs
  services/       the plugin's logic
  dashboard/      settings.json (settings page)
  lang/           en.json, de.json
  test/           node:test tests with the SDK test kit
```

## The tools

In the BotHub repository, `sdk/market`:

```
npm run create -- myplugin --features nodes,commands,storage
npm run validate -- plugin_myplugin
npm test -- plugin_myplugin
npm run pack -- plugin_myplugin
npm run index
```

`validate` runs the same checks as the installation. `pack` builds the zip, `index` the catalog `index.json`.

## The SDK

`ctx` offers storage, settings (`ctx.config`, also dropdowns the plugin fills with `ctx.config.setOptions`), Discord calls (messages, members, roles, channels, interactions, voice), the economy, Data Storage variables, files, HTTP to declared hosts and `ctx.http.secret` for secrets. Every call needs its SDK permission; the full list is `sdk/API.md` in the BotHub repository.

> [!TIP]
> A plugin never gets the bot token, a database handle or free network access. Ask for as few permissions as possible: the admin sees them before installing.

## Publish

1. Raise `version` in `bothub.json`, run `npm run check`.
2. `npm run pack` and `npm run index`.
3. Create a GitHub release `plugin_x-<version>` with the zip and commit `index.json`.
