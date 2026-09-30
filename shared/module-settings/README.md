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
| `color`    | `#rrggbb`                                               | `default`                            |
| `channel`  | `{id, guild}` or `null`                                 | `channelTypes`                       |
| `channels` | `[{id, guild}]`                                         | `channelTypes`, `max`                |
| `role`     | `{id, guild}` or `null`                                 |                                      |
| `roles`    | `[{id, guild}]`                                         | `max`                                |
| `emojis`   | `["👍", "<:name:id>"]`                                  | `max`                                |
| `words`    | `["text", …]`                                           | `max`, `maxLength`                   |
| `message`  | `{mode, content, title, description, color, image, footer}` (mode `text` or `embed`) | `default` |
| `list`     | `[{…item fields…}]`                                     | `item` (fields), `max`, `titleField` |

List fields may have `unique: ["field", …]`: the API refuses two entries with the same
values in these fields. `hint: true` shows the text `modset.<module>.<key>_hint` below
the field (or at the top of a list).

`showIf: {"field": ["value", …]}` hides a field in the form unless another
field on the same level has one of the values (booleans as `"true"`/`"false"`);
the API still stores it. Channel types: `text`, `voice`, `category`, `forum`,
`announcement`. Messages support the placeholders of `shared/events.json`,
e.g. `{user.mention}`, `{server}`, `{members}`.
