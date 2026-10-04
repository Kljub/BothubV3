-- Options a plugin fills at run time for a "choices" field with
-- "dynamic": true (ctx.config.setOptions), per bot: e.g. the Plex libraries
-- of the bot owner's servers as "Server:Library". The dashboard shows them in
-- the field's dropdown; options is a JSON list of {value, label}.

CREATE TABLE plugin_field_options (
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    plugin_id  TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 100),
    field      TEXT NOT NULL CHECK (length(field) BETWEEN 1 AND 32),
    options    TEXT NOT NULL CHECK (json_valid(options) AND length(options) <= 65536),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, plugin_id, field)
) STRICT, WITHOUT ROWID;
