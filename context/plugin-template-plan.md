# Plugin template: preparation (bothub-96)

Status: **concept only**. Work starts when every module has Codex APPROVED
(user's order, see `codex-module-review.md`). Before building, Codex reviews
this plan once.

## Goal

A plugin author copies one folder and has a working plugin with everything
BotHub needs: builder blocks, an own settings page in the dashboard (BotHub
UI only), texts in en/de, tests, and a way to install it on a bot. The 18
market plugins (`github.com/Kljub/bothub_market`, v2 format) are later ported
onto this template (decision "Weg B").

## What exists

- SDK v1 (`sdk/`): manifest `bothub-plugin.json`, `index.js` with `start` and
  `blocks`, permissions `storage`, `discord.send_messages`,
  `discord.guild_info`, `log`, limits, sandbox (one process per plugin and bot).
- Example `sdk/examples/counter` (blocks only).
- Runtime and SDK manager in the bot (`bot/src/sdk/*`), admin SDK policies
  (`api/src/Internal/SdkPolicyStore.php`).
- Content rule: templates in `dashboard/ui/templates/plugins/` may use only
  global component classes (`TestContentUsesOnlyComponents`).

## Missing (what the template adds)

1. **Settings in the manifest.** A `settings` block in the same format as
   `shared/module-settings/<key>.json` (fields, types, `showIf`, lists). The
   dashboard renders it with the existing schema renderer (`modsettings.go`),
   the API validates it (`ModuleSettings.php`), the plugin reads it via a new
   read-only call `ctx.config()` (no extra permission: own config only).
   → One form system for modules and plugins, no plugin HTML needed for the
   usual case.
2. **Texts.** `lang/en.json`, `lang/de.json` in the plugin folder with keys
   `plugin.<id>.*` (name, description, setting labels/hints, block labels).
   Loaded by the dashboard at install; block `labelKey`s point to them.
3. **Optional custom page.** `templates/page.html` (html/template, only global
   classes) for plugins whose page is more than a form. Rendered inside the
   bot's plugin page; data comes from `ctx.storage` via a read-only API.
4. **Events (optional, later).** `events: ["message_create", …]` in the
   manifest so a plugin reacts without a builder block; needs a new SDK
   permission per event group. Not in the first template.
5. **Tests.** `test/plugin.test.js` with a fake `ctx` (storage in memory,
   recorded sends) shipped with the SDK (`@bothub/sdk/testing`), so authors
   test blocks without a bot.
6. **Packaging and install.** `bothub plugin pack` (SDK CLI) builds a zip +
   SHA-256; the market index lists id, version, hash. Install via the API
   checks hash, manifest schema and permissions, stores files under
   `/data/plugins/<id>/<version>`, and the user grants permissions per bot.

## Template folder

```
plugin-template/
├── bothub-plugin.json        id, name, version, sdk, main, permissions, blocks, settings
├── index.js                  start(ctx), blocks.{…}; reads ctx.config()
├── lang/en.json, lang/de.json
├── templates/page.html       optional, global classes only
├── test/plugin.test.js       uses @bothub/sdk/testing
└── README.md                 how to rename, test, pack, install
```

Example content: a "Greeter" plugin with one setting list (channel +
message), one block ("send greeting"), storage for a counter, tests.

## Dashboard (BotHub UI)

- Bot → Plugins: installed plugins with on/off, permissions (granted/asked),
  "Settings" opens the plugin page (schema form, or `page.html`).
- Admin → Plugin Manager: install from market / upload, versions, SDK policies.
- No plugin CSS or JS; the CSP stays `script-src 'self'`.

## Open questions for the user (ask when work starts)

- Should plugins be able to register slash commands directly, or only blocks
  (commands are then built in the builder with the plugin's blocks)?
- Market upload only by the admin, or also by other BotHub users?
