# Plugin template: preparation (bothub-96)

Status: **ready to build** (all modules Codex APPROVED on 2026-09-30).
Codex plan review done (2026-09-30); its 10 points are applied in
"Changes after the Codex review" below, which overrides the parts above.

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
├── commands/greet.json       optional slash command graphs (installed as disabled copies)
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

## Decisions (user, 2026-09-30)

- **Plugins may ship their own slash commands.** They are graphs in the
  plugin folder (`commands/<name>.json`, same format as
  `shared/command-presets.json` entries). On install for a bot they are
  created as **disabled** copies in Custom Commands, in a group named after the
  plugin (like the module presets), so the user sees and edits them in the
  builder and the DB stays the source of truth. Uninstall asks whether to
  delete them.
- **Only the admin installs plugins** (market or upload). Bot owners switch
  them on per bot and grant the permissions.

## Changes after the Codex review (binding)

1. **No `templates/page.html` in v1.** Plugin pages come only from the settings
   schema (rendered by the dashboard, auto-escaped). No plugin HTML, CSS or JS.
2. **Manifest v1 extension** (`shared/plugin-manifest.schema.json`, stays
   `additionalProperties: false`): `settings` (field list, same types as
   module settings **without** secret values; max 50 fields, text max 2000,
   list max 50 items), `commands` (file names under `commands/`, max 25),
   `lang` (fixed to `lang/en.json`, `lang/de.json`, keys only `plugin.<id>.*`,
   max 64 KB each). Bot parser and API validate the same schema.
3. **Config is read-only for the plugin**: `ctx.config()` returns this bot's
   saved settings; host and API refuse any config write from the plugin.
4. **Secrets**: plugins never receive values in settings, logs or tests. A
   plugin that needs an API uses a global endpoint by key through a host call
   that adds the header (the value never enters the sandbox), limited to
   endpoints the admin shared with the plugin (`secret_plugin_shares`).
5. **Install pipeline (API, one transaction)**: zip limits (max 200 files,
   5 MB packed, 20 MB unpacked, max 2 MB per file), refuse `..`, absolute
   paths, symlinks, duplicate names, non-UTF-8 names; SHA-256 must match the
   market index; unpack to a temp dir, validate manifest + lang + commands,
   then move atomically to `/data/plugins/<id>/<version>`.
6. **Plugin commands**: every node type must be a built-in node or one of
   this plugin's own blocks (`plugin.<id>.*` declared in its manifest); same
   graph limits and CommandStore validation as the builder. Copies are
   created **disabled**, carry provenance (`plugin_id`, `plugin_version`,
   `preset_name`), install is idempotent (existing copies are not
   overwritten), an update adds new commands only and reports changed ones,
   uninstall asks whether to delete the copies.
7. **Order**: (a) schemas + install pipeline + validation (API/bot),
   (b) dashboard pages, (c) SDK testing kit, (d) template folder + README,
   (e) Codex review of the result.

## Split between sessions (proposal)

- bothub-96: manifest schema extension, dashboard (Bot → Plugins settings
  page from the schema, Admin → Plugin Manager install/upload UI), template
  folder + README, `@bothub/sdk/testing`.
- Owner of the SDK/runtime (bot/src/sdk, sdk/): `ctx.config()`, host call for
  global endpoints, manifest parsing in the bot.
- Owner of the API: install pipeline, plugin command copies with provenance,
  settings validation for plugins.

## Manifest v1 extension: final fields (bothub-96, 2026-09-30)

Added to `bothub-plugin.json` (schema stays `additionalProperties: false`):

```jsonc
"settings": {                      // optional; per-bot settings page
  "fields": [ /* max 50 */ ]       // same field format as shared/module-settings (README)
},
"commands": ["commands/greet.json"], // optional; max 25; pattern ^commands/[a-z0-9_-]{1,32}\.json$
"lang": { "en": "lang/en.json", "de": "lang/de.json" } // optional; exactly these paths
```

**settings.fields[]**: `key` ^[a-z][a-zA-Z0-9_]{0,31}$ (unique), `type` one of
bool, text, number, select, color, channel, channels, role, roles, emojis,
words, message, list; options as in module settings (`default`, `min`, `max`,
`maxLength`, `multiline`, `pattern`, `options` max 25, `channelTypes`,
`showIf`, `item` for list with max 20 fields, `titleField`). Limits: text
`max`/`maxLength` ≤ 2000, `list.max` ≤ 50, `words`/`emojis`/`channels`/`roles`
`max` ≤ 50, no nested list inside a list, **no secret type**.

**commands/<name>.json**: `{ "name": …, "description": …, "graph": {…} }`
(same as a `shared/command-presets.json` entry without module/group; the
group is the plugin name). Node types: built-in nodes or this plugin's own
`plugin.<id>.<block>`.

**lang/<code>.json**: flat `{ "plugin.<id>.<…>": "text" }`, only keys with
the plugin's prefix, values ≤ 500 chars, file ≤ 64 KB. Key convention:
`plugin.<id>.name`, `.description`, `.setting.<key>`, `.setting.<key>_hint`,
`.setting.<key>.<option>`, `.setting.<list>.<itemKey>`, `.block.<name>.label`,
`.block.<name>.description`. Block definitions use these keys as
`labelKey`/`descriptionKey`. Missing German text falls back to English.

## Status (bothub-96, 2026-10-01)

Done and Codex APPROVED (2 rounds):

- `shared/plugin-manifest.schema.json`: `settings`, `commands`, `lang` with `$defs/field` and `$defs/itemField`.
- Dashboard: Admin → Plugins (Plugin Manager: zip upload, market id + version, list, uninstall with or without the command copies), Bot → Plugins → plugin page with the settings form from `manifest.settings` (module settings renderer via `settingsScope`, labels `plugin.<id>.setting.*`). Plugin texts are loaded into the i18n bundle per plugin and only under `plugin.<id>.`.
- Mock forwards the plugin routes to the PHP API.
- `@bothub/sdk/testing` (`sdk/src/testing.ts`): fake ctx with the host's keys and limits, `runBlock`.
- `plugin-template/`: Greeter example, tests (`npm test`), `npm run pack` (zip + SHA-256), README.
- E2E mock → PHP: install, repeated install, broken zip (422), config defaults/save/validation, disabled `/greet` copy, uninstall with `deleteCommands`.

Open: bot side of `ctx.config` from `plugin_settings` and the host call for global endpoints (bothub-03); browser check of the two pages.

## Moved to the market repo (bothub-96, 2026-10-01)

The template now lives in github.com/Kljub/BothubMarketPlace (local:
D:\Work\Projects\BothubMarketPlace): `Template/` (base + features blocks,
settings, commands, storage, messages, events, tasks, api, voice),
`scripts/create.mjs` (plugin from chosen features), validate/pack/index,
example plugins in `plugins/`, `index.json` for BOTHUB_MARKET_INDEX. The old
`plugin-template/` folder here is gone. New manifest fields `endpoints`,
`events`, `tasks` (schema here, PluginStore checks them); SDK calls
`voice.*`, `http.endpoint`, declarative events/tasks are in the catalog and
the testing kit, the bot runtime is built by the SDK owner. Endpoint sharing
with plugins: table endpoint_plugin_shares (bothub-57) + checkboxes in
Admin → Plugins.

## Market repo layout (user, 2026-10-01)

The market repo root holds only plugin folders plus `index.json`. First and
only one so far: `Template/` (id `template`, every layer; built with
`create --features all`). The example plugins (starter, welcome, api-lookup,
soundboard) were taken out; they are in the market history (commit 3f96eb9)
and come back later as root folders. The tools moved to this repo:
`sdk/market/` (create, validate, test, pack, index, sync-sdk; feature parts
in `sdk/market/parts/`). Each plugin has its own `package.json` and
`test/lib/` (SDK test kit copy) so it is self-contained. Zips are no longer
in the market repo: they go to GitHub Releases (tag `<id>-<version>`), and
`index.json` points there.

## App Store (bothub-31, 2026-10-03)

All plugin management moved into its own page `/store` (user menu →
App Store); the Admin → Plugins tab is gone. The store lists market plugins
plus installed uploads (badge "Uploaded"), has the zip upload, and the
detail page shares API endpoints and shows install facts (SHA, date,
events, tasks). Search, status filter (all / installed / updates), category chips,
cards per plugin; `/store/<id>` shows contents (release layers), permissions
with risk and current SDK policy, endpoints, facts, install/update and
uninstall. Admin installs, bot owners switch on per bot (unchanged).
New optional bothub.json fields `icon` (emoji, max 16 code points, no
markup characters) and `category` (module group key, default utility);
API, schema, market tools (index.json carries both) and the bot plugin card
use them. Next: port the 16 remaining v2 plugins (bothub_market) onto the
SDK only, no database access; missing SDK features go to
`context/plugin-sdk-gaps.md` for a later discussion.
