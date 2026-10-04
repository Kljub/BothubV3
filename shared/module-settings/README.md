# Module settings

One file per module with a settings page (`<module key>.json`, key from
`modules.json`). The API validates `bot_modules.config` against it
(`api/src/Internal/ModuleSettings.php`), the dashboard renders the form from
it (`dashboard/internal/web/modsettings.go`) and the bot reads the stored
config (`bot/src/modules/*.ts`).

A file has `fields`, a list of fields. Every field has `key` and `type`.
Labels are the i18n keys `modset.<module>.<key>`, hints `modset.<module>.<key>_hint`
(optional) and select options `modset.<module>.<key>.<option>`. Fields of a
list item use `modset.<module>.<list>.<key>`.

| type       | value                                                   | options                              |
|------------|---------------------------------------------------------|--------------------------------------|
| `bool`     | `true` / `false`                                        | `default`                            |
| `text`     | string                                                  | `default`, `max`, `multiline`, `pattern` (regex; empty text always passes) |
| `number`   | integer                                                 | `default`, `min`, `max`              |
| `select`   | one of `options`                                        | `options`, `default`                 |
| `choices`  | `["value", …]` (several picks)                          | `options` (strings), `dynamic` (plugins: options from `ctx.config.setOptions`), `max` |
| `color`    | `#rrggbb`                                               | `default`                            |
| `channel`  | `{id, guild}` or `null`                                 | `channelTypes`                       |
| `channels` | `[{id, guild}]`                                         | `channelTypes`, `max`                |
| `role`     | `{id, guild}` or `null`                                 |                                      |
| `roles`    | `[{id, guild}]`                                         | `max`                                |
| `emojis`   | `["👍", "<:name:id>"]`                                  | `max`                                |
| `words`    | `["text", …]`                                           | `max`, `maxLength`                   |
| `message`  | `{mode, content, title, description, color, image, footer}` (mode `text` or `embed`) | `default` |
| `list`     | `[{…item fields…}]`                                     | `item` (fields), `max`, `titleField` |
| `permissions` | `{allowed_roles: [{id, guild} or {id: "everyone"}], banned_roles: [{id, guild}], required_permissions: ["manage_messages", …], banned_channels: [{id, guild}]}` | `lists` (which of the four to show), `default`, `group` |

Role and channel fields use the same picker as the node editor (server, then its roles or channels; chips; add by ID). `permissions` is the permissions block of the slash trigger: who may trigger the module and where (same check as for commands, `denied()` in bot/src/discord/commands.ts).
With `group: true` the block describes a group of members instead (e.g. who
is exempt; `inBlock()`): no @everyone, no open/restricted badge, and no value
means nobody. Own card texts: `permblock.<label>.who`, `.<list>`, `.<list>_hint`,
`.<list>_empty`, where `<label>` is the field's label key (e.g.
`permblock.modset.honeypot.exempt.allowed_roles`).

Any field may have `required: true` (empty values are refused on save). List entries get a
stable `_id` from the API (kept on edits), so the bot can keep state per entry.

List fields may have `unique: ["field", …]`: the API refuses two entries with the same
values in these fields. `hint: true` shows the text `modset.<module>.<key>_hint` below
the field (or at the top of a list).

`showIf: {"field": ["value", …]}` hides a field in the form unless another
field on the same level has one of the values (booleans as `"true"`/`"false"`);
the API still stores it. Channel types: `text`, `voice`, `category`, `forum`,
`announcement`. Messages support the placeholders of `shared/events.json`,
e.g. `{user.mention}`, `{server}`, `{members}`.

`vars: ["user.mention", "server", …]` on a text or message field lists the
placeholders the bot really fills there (bot/src/modules: `baseVars` plus the
field's extras). The settings page shows exactly these in its variable
picker; keep the list in step with the module code.
