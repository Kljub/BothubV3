# Plugin format (bothub.json)

A plugin talks only to the BotHub SDK; the SDK talks to the core, and the
core to Discord, the database and Redis.

```
Plugin
  ├── Commands    commands/<name>.json     slash command graphs
  ├── Events      events/<event>.js        Discord event handlers
  ├── Services    services/*.js            timed tasks, external APIs, shared code
  ├── Nodes       nodes/<name>.json + .js  builder blocks
  └── Dashboard   dashboard/settings.json  settings page per bot
        │
        ▼
   BotHub SDK  (ctx: permissions, limits, sandbox)
        │
        ▼
      Core  →  Discord · DB · Redis
```

## Folder

```
plugin_my_plugin/
├── bothub.json             the plugin file (schema: plugin-manifest.schema.json)
├── index.js                "main": joins nodes, events and services (definePlugin)
├── commands/<name>.json    { name, description, graph }
├── events/<event>.js       export default async (ctx, payload) => {}
├── services/<name>.js      tasks (export const tasks = { name: async (ctx) => {} }) and helpers
├── nodes/<name>.json       node definition (category, labelKey, inputs, outputs, results, config)
├── nodes/<name>.js         export default async (ctx, { config, vars }) => ({ results })
├── dashboard/settings.json { fields: [...] } (module-settings format, no secrets)
├── lang/en.json, de.json   texts, keys plugin.<id>.*
└── sounds/*.ogg|mp3|wav    files for voice.play
```

## bothub.json

Plugin IDs are `plugin_<name>`: lowercase letters, digits and `_`, at most
64 characters (`^plugin_[a-z0-9_]{1,57}$`). The ID is also the folder name,
the text prefix (`plugin.<id>.`) and part of every node type
(`plugin.<id>.<node>`).

```jsonc
{
  "schemaVersion": 1,
  "id": "plugin_starter",
  "name": "Starter Kit",
  "version": "1.0.0",
  "description": "Short text for the plugin list.",
  "developer": { "name": "BotHub", "url": "https://github.com/Kljub", "email": "dev@example.com" },
  "license": "MIT",
  "icon": "🌤️",
  "category": "utility",
  "sdk": { "version": 1, "permissions": ["storage", "discord.messages.send"] },
  "main": "index.js",
  "commands": ["commands/hello.json"],
  "events": ["guildMemberAdd"],
  "services": { "tasks": [{ "name": "daily_report", "cron": "0 9 * * *" }], "secrets": ["WEATHER_URL", "WEATHER_KEY"] },
  "nodes": ["hello"],
  "dashboard": { "settings": "dashboard/settings.json" },
  "lang": { "en": "lang/en.json", "de": "lang/de.json" }
}
```

`icon` (one emoji, default 🧩) and `category` (a module group key:
utility, security, messages, fun, ticket, social; default utility) place
the plugin in the App Store.

`sdk.permissions` are the SDK permissions the admin must enable under
Admin → SDK policies. Rules: `events` needs `discord.events`,
`services.tasks` needs `scheduler`, `services.secrets` needs `secrets.use`
(requests with secrets) or `secrets.read` (values), a `sounds/` folder needs
`discord.voice`.

## Normalized manifest

The API (PluginStore) and the bot (sdk/manifest.ts) read `bothub.json` and
the files it names, check them, and work with one normalized object. The API
stores and returns this object as `manifest`; the dashboard reads only it.

| normalized      | from bothub.json |
|-----------------|------------------|
| `id`, `name`, `version`, `description`, `main`, `commands`, `events`, `lang` | same |
| `author`        | `developer.name` |
| `developer`     | `developer` |
| `license`       | `license` |
| `icon`, `category` | same (optional; App Store and plugin card) |
| `sdk`           | `sdk.version` |
| `permissions`   | `sdk.permissions` |
| `tasks`         | `services.tasks` |
| `secrets`       | `services.secrets` |
| `blocks`        | `nodes[]` → `{ name, definition: <nodes/<name>.json> }` |
| `settings`      | content of `dashboard/settings.json` |

Missing optional parts become empty (`[]`, no `settings`). A reference
implementation is `normalize()` in the market repo
(`BothubMarketPlace/scripts/lib/plugins.mjs`).

## Access rules in plugin settings

A plugin that limits who may use a feature declares a `permissions` field in
`dashboard/settings.json`. The bot owner sees the same permissions block as
in the command editor: allowed roles, banned roles, required permissions and
banned channels.

```json
{ "fields": [
  { "key": "who_may_link", "type": "permissions", "default": { "allowed_roles": [{ "id": "everyone" }] } }
] }
```

The plugin code checks a member with `ctx.config.checkAccess(key, who)`. This
is a core call and needs no SDK permission. `who` is an interaction event or
`{ userId, guildId, channelId }`. The call reads the saved value on every
check, so a change on the dashboard counts at once. It uses the same rules as
a command's permissions block (`denied()` in bot/src/discord/commands.ts):

```js
const access = await ctx.config.checkAccess('who_may_link', event);
if (!access.allowed) return ctx.interaction.reply(event.handle, { content: 'Not allowed here.', ephemeral: true });
```

Result: `{ allowed, reason }`. `reason` is one of `role`, `banned_role`,
`permission`, `channel`, `member` (not on the server) or `null`. In DMs the
check always allows. A key that is not a `permissions` field fails with
`sdk.config.not_permissions`. Bad IDs fail with `sdk.config.bad_member`.

## Settings the plugin reads and changes

`ctx.config.get(key)` answers with the settings of the current bot: the
values saved on the dashboard, and the field defaults for fields nobody saved
yet. A dashboard save reaches the running plugin at once.

`ctx.config.set(key, value)` changes one field, for example a list entry
that a command adds. The bot checks the value like a dashboard save: the key
must be a field of `dashboard/settings.json` (`sdk.config.unknown_key`), the
value must fit its type (`sdk.config.bad_value`). List entries get an `_id`.
`permissions` and `message` fields stay with the dashboard
(`sdk.config.not_settable`), so a plugin cannot change who may use it.
`ctx.config.delete(key)` sets a field back to its default. Both are core
calls and need no SDK permission.

## Images (plugin files)

An `image` field in `dashboard/settings.json` gets an upload button with a
preview on the dashboard. The field value is the name of the stored file.
Image fields need the SDK permission `storage.files`.

```json
{ "fields": [
  { "key": "emojis", "type": "list", "max": 50, "titleField": "name", "item": [
    { "key": "name", "type": "text", "max": 32 },
    { "key": "image", "type": "image" }
  ] }
] }
```

- PNG, GIF, WEBP and JPEG, recognized by their first bytes. Max. 2 MB per
  image, 100 images and 25 MB per plugin and bot.
- The name is the first 16 hex characters of the SHA-256 plus the extension
  (`3f2a9c0d1b7e4a55.png`). The same picture always gets the same name.
- An upload that no setting names is removed at the next save. When a
  setting stops naming an image (dashboard save or `config.set`), the image is
  removed too. Uninstalling the plugin removes all its images.

With `storage.files` the plugin manages its images itself:

```js
const list = await ctx.files.list();                       // [{ name, mime, size }]
const file = await ctx.files.get(name);                    // { name, mime, size, data: base64 } | null
const stored = await ctx.files.fromDiscord(attachment.url); // a command's attachment option
await ctx.files.delete(name);
```

`ctx.files.put(base64)` stores small images (about 48 KB per call, the size
of one plugin message); bigger ones come from the dashboard or from Discord.
`fromDiscord` accepts only `https://cdn.discordapp.com/…` and
`https://media.discordapp.net/…` links below `/attachments/` or
`/ephemeral-attachments/` (the files of a command's attachment option).

`ctx.message.sendFile(channelId, name, message?)` (SDK permission
`discord.messages.files`) posts an image as an attachment. In an embed,
`image_url: "attachment"` or `thumbnail_url: "attachment"` shows the file
inside the embed:

```js
await ctx.message.sendFile(channelId, emoji.image, { mode: 'embed', embeds: [{ title: emoji.name, image_url: 'attachment' }] });
```

## Secrets (addresses and API keys)

Admin → API / Secrets holds only secrets: a name, the value and a
description. An address (base URL) is a secret too. A plugin declares every
name it uses in `bothub.json` (`services.secrets`); the admin shares each one
with the plugin in the App Store.

**Requests with secrets** (SDK permission `secrets.use`, recommended): the
bot adds address and key, the plugin never sees them.

```json
{ "sdk": { "version": 1, "permissions": ["secrets.use"] },
  "services": { "secrets": ["WEATHER_URL", "WEATHER_KEY"] } }
```

```js
const res = await ctx.http.secret({
  url: 'WEATHER_URL',              // secret with the address, e.g. https://api.openweathermap.org/data/2.5
  path: '/weather',                // added to the address
  query: { q: 'Berlin' },
  auth: { secret: 'WEATHER_KEY', format: 'query', param: 'appid' }, // or header: 'X-Api-Key', format: 'plain'
});
```

- `url` is the name of an address secret (any address the admin set, also in
  the home network) or a full https URL of a host in `services.hosts`
  (public addresses only).
- `auth.format`: `bearer` (default, header `Authorization: Bearer <key>`),
  `plain` (header with the key as it is) or `query` (URL parameter `param`).
- Secret values are masked in the answer. Answer max. 1 MB, timeout 10 s.
- With `storage.files` too: `file: { name, field }` sends an image of the
  plugin files as multipart/form-data (text values in `fields`, not together
  with `json`); `saveAs: 'file'` stores a successful image answer (PNG, GIF,
  WEBP or JPEG, max. 2 MB) in the plugin files and answers
  `{ status, headers, file }`.

```js
const auth = { secret: 'EXAMPLE_KEY', header: 'x-api-key', format: 'plain' };
const src = await ctx.files.fromDiscord(attachmentUrl);
const up = await ctx.http.secret({ url: 'https://api.example.com/upload', method: 'POST', auth, file: { name: src.name, field: 'image' } });
const out = await ctx.http.secret({ url: 'https://api.example.com/result.png', auth, saveAs: 'file' });
await ctx.message.sendFile(channelId, out.file.name, { spoiler: false });
```

**Reading a value** (SDK permission `secrets.read`, high risk): when a library
needs the key itself.

```js
const key = await ctx.secrets.get('WEATHER_KEY'); // null when not shared
```

Rules:

- Names are upper case: `A-Z`, `0-9` and `_`, 2 to 40 characters; at most 20
  per plugin.
- A plugin can use only names that its manifest lists AND that the admin
  shared with it. Any other name answers like a secret that does not exist
  (`null` / `sdk.secret.not_shared`). A plugin therefore cannot find out
  which secrets exist.
- At install every declared name that does not exist yet is created empty
  (`[NULL]`) in Admin → API / Secrets and shared with the plugin; the admin
  only pastes the value. Until then the plugin gets `null`. Names a sign-in
  helper fills (`services.connect`: token and address) are left out;
  existing secrets are never changed or shared automatically. Uninstalling
  removes placeholders that are still empty and used by no other plugin.
- There is no call that lists secrets.
- Values the plugin read are masked (`••••`) in its log lines.
- Uninstalling the plugin removes its shares.

Where the names come from: the bot only accepts names of the manifest the
API checked and stored at install (`plugins.manifest`). Plugin settings and
files changed later do not count, so a manipulated plugin folder or settings
value cannot widen its access. The market check (`npm run check`) also reads
the plugin code: every `ctx.secrets.get/has` must name its secret as fixed
text that `services.secrets` declares, so the App Store lists exactly what
the plugin reads, before the install, in its details and the install dialog.
