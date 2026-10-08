-- Playbacks and errors: one row per run of a command or custom event, with
-- its steps (block, status, time, changed variables, settings with the
-- variables filled in). The bot keeps the last 10 runs per command and
-- failed runs for 7 days. A failed run names the block and the reason in
-- plain words (shared/run-errors.json); the Errors page lists them.

CREATE TABLE run_traces (
    id           INTEGER PRIMARY KEY,
    bot_id       INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    command_id   INTEGER NOT NULL REFERENCES commands (id) ON DELETE CASCADE,
    run_key      TEXT NOT NULL CHECK (length(run_key) BETWEEN 1 AND 32),
    at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    source       TEXT NOT NULL DEFAULT '' CHECK (length(source) <= 32), -- slash, button, menu, event, timed, webhook
    user_id      TEXT,
    user_name    TEXT,
    guild_id     TEXT,
    guild_name   TEXT,
    channel_id   TEXT,
    channel_name TEXT,
    ok           INTEGER NOT NULL CHECK (ok IN (0, 1)),
    error_node   TEXT,
    error_key    TEXT,
    -- {key, params, text, fix}: key in run-errors.json, English text and fix
    error_hint   TEXT CHECK (error_hint IS NULL OR json_valid(error_hint)),
    error_text   TEXT,
    start_vars   TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(start_vars)),
    steps        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(steps)),
    -- blocks that would fail (checked before the run), [{node, text}]
    warnings     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(warnings)),
    dismissed    INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0, 1))
) STRICT;

CREATE INDEX run_traces_command ON run_traces (command_id, id);
CREATE UNIQUE INDEX run_traces_key ON run_traces (command_id, run_key);
CREATE INDEX run_traces_errors ON run_traces (bot_id, ok, dismissed, id);

-- Muted errors: same block, same reason; no alerts and fix tips, not listed.
CREATE TABLE run_error_mutes (
    command_id INTEGER NOT NULL REFERENCES commands (id) ON DELETE CASCADE,
    node_id    TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 64),
    error_key  TEXT NOT NULL CHECK (length(error_key) BETWEEN 1 AND 100),
    at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (command_id, node_id, error_key)
) STRICT;
