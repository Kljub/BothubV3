-- Commands, custom events and timed events: every one is a graph
-- (shared/graph.schema.json), run by the graph interpreter in the bot.

-- Folders on the custom commands page, shared by commands and events.
CREATE TABLE command_groups (
    id          INTEGER PRIMARY KEY,
    bot_id      INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 200),
    position    INTEGER NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 999),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX command_groups_bot ON command_groups (bot_id, position);

CREATE TABLE commands (
    id          INTEGER PRIMARY KEY,
    bot_id      INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'command' CHECK (kind IN ('command', 'event', 'timed')),
    -- Commands: Discord name ("ticket open" for a subcommand).
    -- Events and timed events: the nickname shown in the dashboard.
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 100),
    -- Built-in module commands ship a default graph (reset restores it).
    -- A custom copy may share the name of a built-in command, but only one
    -- command per top-level name can be enabled; the API enforces that.
    builtin     INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    module_key  TEXT, -- owning module of a built-in command
    enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    group_id    INTEGER REFERENCES command_groups (id) ON DELETE SET NULL,
    event_type  TEXT, -- custom events: key from shared/events.json
    graph       TEXT NOT NULL CHECK (json_valid(graph)),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    -- Deleted custom commands and events stay 30 days under "Recently deleted".
    deleted_at  TEXT,
    CHECK (builtin = 0 OR (kind = 'command' AND module_key IS NOT NULL)),
    CHECK (kind = 'event' OR event_type IS NULL)
) STRICT;

CREATE INDEX commands_bot ON commands (bot_id, kind) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX commands_custom_name ON commands (bot_id, name) WHERE kind = 'command' AND builtin = 0 AND deleted_at IS NULL;
CREATE UNIQUE INDEX commands_builtin_name ON commands (bot_id, module_key, name) WHERE builtin = 1;
CREATE INDEX commands_event_type ON commands (bot_id, event_type) WHERE kind = 'event' AND enabled = 1 AND deleted_at IS NULL;

-- The last saves of a command (the API keeps 3). Restoring a version saves
-- it again as the newest one.
CREATE TABLE command_versions (
    id         INTEGER PRIMARY KEY,
    command_id INTEGER NOT NULL REFERENCES commands (id) ON DELETE CASCADE,
    saved_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    saved_by   INTEGER REFERENCES users (id) ON DELETE SET NULL,
    nodes      INTEGER NOT NULL,
    graph      TEXT NOT NULL CHECK (json_valid(graph))
) STRICT;

CREATE INDEX command_versions_command ON command_versions (command_id, id DESC);

-- Saved messages of the message builder.
CREATE TABLE message_templates (
    id         INTEGER PRIMARY KEY,
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    message    TEXT NOT NULL CHECK (json_valid(message)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX message_templates_bot ON message_templates (bot_id);

-- Cooldowns of the slash trigger (runtime, written by the bot).
-- scope_key: '' (global), 'g:<guild>', 'u:<user>' or 'g:<guild>:u:<user>'.
CREATE TABLE command_cooldowns (
    command_id INTEGER NOT NULL REFERENCES commands (id) ON DELETE CASCADE,
    scope_key  TEXT NOT NULL,
    until      TEXT NOT NULL,
    PRIMARY KEY (command_id, scope_key)
) STRICT, WITHOUT ROWID;

-- Scheduled work of the bot: undo after a set time, timed events, giveaway
-- and poll ends, wait blocks that outlive a restart. key lets a graph cancel
-- a job (Cancel Job block).
CREATE TABLE scheduled_jobs (
    id           INTEGER PRIMARY KEY,
    bot_id       INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    kind         TEXT NOT NULL, -- undo, timed_event, giveaway_end, poll_end, resume
    key          TEXT,
    run_at       TEXT NOT NULL,
    payload      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    done_at      TEXT,
    cancelled_at TEXT,
    error_key    TEXT
) STRICT;

CREATE INDEX scheduled_jobs_due ON scheduled_jobs (run_at) WHERE done_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX scheduled_jobs_key ON scheduled_jobs (bot_id, key) WHERE key IS NOT NULL;

-- Variables of the Set/Delete Variable blocks. scope 'run' lives only in
-- memory. scope_id: '' (global), '<guild>' (server), '<guild>:<user>' (user).
CREATE TABLE variables (
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    scope      TEXT NOT NULL CHECK (scope IN ('global', 'server', 'user')),
    scope_id   TEXT NOT NULL DEFAULT '',
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    value      TEXT NOT NULL CHECK (length(value) <= 500),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, scope, scope_id, name)
) STRICT, WITHOUT ROWID;
