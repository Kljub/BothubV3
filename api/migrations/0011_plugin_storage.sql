-- Plugin SDK: key-value storage per bot and plugin. Plugins never touch the
-- database; the SDK manager in the bot reads and writes these rows for the
-- storage.* calls (permission "storage") and enforces the quotas of
-- shared/sdk-permissions.json (keys, value size, total size).

CREATE TABLE plugin_storage (
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    plugin_id  TEXT NOT NULL CHECK (plugin_id GLOB '[a-z0-9]*' AND length(plugin_id) <= 64),
    key        TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
    value      TEXT NOT NULL CHECK (length(value) <= 16384),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, plugin_id, key)
) STRICT, WITHOUT ROWID;
