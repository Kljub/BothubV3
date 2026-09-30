-- Log levels as the dashboard shows them: update, change, warning, error.
-- SQLite cannot change a CHECK constraint, so the table is rebuilt.

CREATE TABLE logs_new (
    id            INTEGER PRIMARY KEY,
    bot_id        INTEGER,
    at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    level         TEXT NOT NULL CHECK (level IN ('update', 'change', 'warning', 'error')),
    code          TEXT,
    key           TEXT NOT NULL DEFAULT '', -- i18n key; empty when code names the text (log.code.<code>)
    params        TEXT CHECK (params IS NULL OR json_valid(params)),
    change        TEXT CHECK (change IS NULL OR json_valid(change)), -- {field, old, new}
    source        TEXT, -- api, bot, dashboard, plugin:<id>
    actor_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL
) STRICT;

INSERT INTO logs_new (id, bot_id, at, level, code, key, params, change, source, actor_user_id)
SELECT id, bot_id, at,
       CASE level WHEN 'warn' THEN 'warning' WHEN 'error' THEN 'error' ELSE 'update' END,
       code, key, params, change, source, actor_user_id
FROM logs;

DROP TABLE logs;
ALTER TABLE logs_new RENAME TO logs;
CREATE INDEX logs_bot_at ON logs (bot_id, at DESC);
