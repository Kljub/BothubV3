-- Plugin files take any file type now (e.g. TempAttachments: PDFs, archives,
-- documents), up to 8 MB each and 50 MB per plugin and bot. Images keep
-- their checked type; other files keep the extension and the original name
-- (filename) for downloads. Executables stay refused (bot). Only images are
-- shown in the dashboard.

CREATE TABLE plugin_files_new (
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    plugin_id  TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 2 AND 64),
    name       TEXT NOT NULL CHECK (name GLOB '[0-9a-f]*.*' AND length(name) BETWEEN 18 AND 25),
    mime       TEXT NOT NULL CHECK (length(mime) BETWEEN 3 AND 100),
    size       INTEGER NOT NULL CHECK (size BETWEEN 1 AND 8388608),
    data       BLOB NOT NULL,
    filename   TEXT NOT NULL DEFAULT '' CHECK (length(filename) <= 100),
    origin     TEXT NOT NULL DEFAULT 'plugin' CHECK (origin IN ('dashboard', 'plugin')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, plugin_id, name)
) STRICT, WITHOUT ROWID;

INSERT INTO plugin_files_new (bot_id, plugin_id, name, mime, size, data, origin, created_at)
SELECT bot_id, plugin_id, name, mime, size, data, origin, created_at FROM plugin_files;

DROP TABLE plugin_files;
ALTER TABLE plugin_files_new RENAME TO plugin_files;
