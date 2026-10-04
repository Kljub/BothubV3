-- Plugin files (SDK permission storage.files): images a plugin keeps per bot,
-- uploaded in the dashboard (image settings field) or stored by the plugin
-- (e.g. a Discord attachment). Name = content hash + extension, so the same
-- picture is stored once. Limits (2 MB per file, 100 files, 25 MB per plugin
-- and bot) are checked by the API and the bot.

CREATE TABLE plugin_files (
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    plugin_id  TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 2 AND 64),
    name       TEXT NOT NULL CHECK (name GLOB '[0-9a-f]*.*' AND length(name) BETWEEN 20 AND 21),
    mime       TEXT NOT NULL CHECK (mime IN ('image/png', 'image/gif', 'image/webp', 'image/jpeg')),
    size       INTEGER NOT NULL CHECK (size BETWEEN 1 AND 2097152),
    data       BLOB NOT NULL,
    -- dashboard: uploaded for a settings field; plugin: stored by the plugin.
    origin     TEXT NOT NULL DEFAULT 'plugin' CHECK (origin IN ('dashboard', 'plugin')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, plugin_id, name)
) STRICT, WITHOUT ROWID;
