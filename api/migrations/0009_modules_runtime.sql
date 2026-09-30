-- Runtime data of the ready-made modules and the webhooks module.
--
-- module_state: small key/value state of a module per bot and server,
--   written by the bot (e.g. counting: current number, sticky roles: the
--   roles of a member who left, starboard: posted message per source
--   message). guild_id '' = not tied to a server. value is JSON.
--
-- webhooks: incoming HTTP triggers that start custom events of type
--   "webhook" (trigger config webhook = event_id). The receiver is public:
--   POST /api/hooks/{botId}/{eventId}.
-- webhook_keys: one API key per bot, stored as SHA-256 hash plus the last
--   4 characters (hint); the key itself is shown once when it is created.

CREATE TABLE module_state (
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    module     TEXT NOT NULL,
    guild_id   TEXT NOT NULL DEFAULT '',
    key        TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
    value      TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, module, guild_id, key)
) STRICT, WITHOUT ROWID;

CREATE TABLE webhooks (
    id             INTEGER PRIMARY KEY,
    bot_id         INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    event_id       TEXT NOT NULL CHECK (length(event_id) BETWEEN 16 AND 40),
    name           TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    require_key    INTEGER NOT NULL DEFAULT 1 CHECK (require_key IN (0, 1)),
    enabled        INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    calls          INTEGER NOT NULL DEFAULT 0,
    last_called_at TEXT,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (bot_id, event_id)
) STRICT;

CREATE TABLE webhook_keys (
    bot_id     INTEGER PRIMARY KEY REFERENCES bots (id) ON DELETE CASCADE,
    key_hash   BLOB NOT NULL,
    hint       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
