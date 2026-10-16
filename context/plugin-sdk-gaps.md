# Plugin SDK gaps

Features of ported v2 plugins that the current SDK (`bot/src/sdk`,
`shared/sdk-permissions.json`) cannot do. Plugins get no database access and
the SDK is not extended on the side: each gap is listed here and discussed
with the user before anything is built. Ported plugins work around it or
leave the feature out.

| Plugin | Feature | What the SDK lacks | Workaround now |
|---|---|---|---|
| AniSearch | `/launchtoday`: "today" in the bot's time zone | No call for the bot's time zone (bots.timezone) | Setting `timezone` on the plugin page (default Europe/Berlin) |
| Plex | Edit the member's Plex watchlist | (solved 2026-10-03) New SDK permission `storage.global`: `ctx.globalStorage`, one space per plugin for the whole instance, 10,000 keys, 10 MB | Member tokens live in the plugin's global storage until /plex-unlink. Plain text in the database and readable by the plugin; an encrypted per-user store (or a host call that adds the token) is still open |
| Potato Pirates | Tell a player that it is their turn | `message.send` never pings, table edits notify nobody | The table shows ➡️ at the player on the turn; turn time limit ends absent turns |
| Riot Games Stats Tracker | All Riot API servers | (solved 2026-10-10, user decision) `services.hosts` raised from 20 to 25 exact hosts (schema, bot manifest.ts, API PluginStore.php) | The plugin uses 21: api.henrikdev.xyz, 5 regional and 15 server hosts of riotgames.com |
| Website Status Check | Ping a role in the down / back-up alert | `message.send` only knows `mentionUsers`; role mentions never ping (allowedMentions parse: []) | Alerts go to a channel without a role ping; a `mentionRoles` option (only roles of the plugin's settings) would solve it |
| Music Quiz | End a round's clip early; reveal a round exactly after its time | Plugins cannot skip or stop songs of the music queue (only `music.enqueue`); `voice.play` takes no https audio and `files.put` only ~48 KB, so a plugin cannot play a downloaded preview itself; `scheduler.timeout` is not implemented, tasks run at most once a minute | The revealed clip plays to its end before the next one; forgotten rounds end at the next minute tick. A `music.skip(guildId, { onlyOwn: true })` (only tracks the plugin queued) and `scheduler.timeout` would solve both |
| Website Status Check | Data of allestörungen.de / Downdetector | Not an SDK gap: the site blocks automated access (Cloudflare), data only via a paid enterprise API | Own user reports (`/sitereport`) and an optional link to the reports page |
| (tooling) | `sdk/market` validate does not check command graphs against node ports | The API refuses a bad graph only at install (`error.graph.bad_port`) | Install the zip once locally before a release |

## Open decision: bot export plugin (user, 2026-10-03)

The user wants to build a plugin later that exports Discord bots including
secrets. A plugin must not see the bot token or secret values (sandbox
rule). Proposal to discuss before anything is built: an SDK call
`bots.export(botId, passphrase)` that returns an encrypted package (BotHub
backup format plus token and secrets, encrypted with the admin's
passphrase) and `bots.import(package, passphrase)`; the plugin only moves
the opaque bytes, decryption happens in the core. Alternative: keep export
in the core (Bot → Backup already exists) and let a plugin only trigger it.

## Added 2026-10-03

`discord.emojis.read` (emoji.list/get), `discord.audit.read` (audit.list),
`discord.voice.moderate` (member.voiceMute/voiceDeafen/voiceDisconnect/
voiceMove), `moderation.cases` (moderation.warn/record/history/getCase/
note/notes, through the Moderation module with DM, log channel and
automatic punishments), `storage.global` (ctx.globalStorage).

## Emoji Manager (v2 3.0.0 -> plugin_emojimanager 1.1.0)

- Solved 2026-10-04: image upload (settings field `image`, plugin files
  `storage.files`, `ctx.files.*`), posting as a file (`message.sendFile`,
  `discord.messages.files`) and `ctx.config.set/delete` (for
  `/emoji-menu add` and `delete`).
- **Use counts on the dashboard**: counted in plugin storage, but a plugin
  cannot show values on its settings page (no read-only/stat field).

## ArcEnCiel (v2 -> plugin_arcenciel 1.0.0)

- Solved 2026-10-04 (user decision "SDK erweitern"): `ctx.http.secret` sends
  a stored image as multipart (`file`) and saves an image answer in the plugin
  files (`saveAs: 'file'`); `message.sendFile` has `spoiler`; `channel.get`
  reports `nsfw`.
- Open: the v2 "Test connection" button (a plugin cannot add a button to its
  settings page).

