-- Data Storage module: variables defined on the dashboard and their values.
--
-- type:   'text', 'number', 'list' (JSON array of text), 'object' (JSON
--         object of text), 'object_list' (JSON array of objects).
-- owner:  'shared' (one value), 'member' (one per member), 'channel' (one
--         per channel).
-- per_server: 1 = separate values in each server, 0 = one value across all
--         servers (owner 'member' then means one value per user).
-- Blocks and messages reference a variable as {var.<key>}.
--
-- data_values.server_id is '' when per_server = 0; owner_id is '' for
-- owner 'shared', the user ID for 'member', the channel ID for 'channel'.
-- value holds text for 'text' and 'number', JSON for the other types.

CREATE TABLE data_variables (
    id            INTEGER PRIMARY KEY,
    bot_id        INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    key           TEXT NOT NULL CHECK (key GLOB '[a-z]*' AND key NOT GLOB '*[^a-z0-9_]*' AND length(key) BETWEEN 1 AND 32),
    name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 32),
    description   TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 200),
    type          TEXT NOT NULL CHECK (type IN ('text', 'number', 'list', 'object', 'object_list')),
    owner         TEXT NOT NULL CHECK (owner IN ('shared', 'member', 'channel')),
    per_server    INTEGER NOT NULL DEFAULT 1 CHECK (per_server IN (0, 1)),
    default_value TEXT NOT NULL DEFAULT '' CHECK (length(default_value) <= 4000),
    group_name    TEXT NOT NULL DEFAULT '' CHECK (length(group_name) <= 40),
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (bot_id, key)
) STRICT;

CREATE TABLE data_values (
    variable_id INTEGER NOT NULL REFERENCES data_variables (id) ON DELETE CASCADE,
    server_id   TEXT NOT NULL DEFAULT '',
    owner_id    TEXT NOT NULL DEFAULT '',
    value       TEXT NOT NULL CHECK (length(value) <= 4000),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (variable_id, server_id, owner_id)
) STRICT, WITHOUT ROWID;

-- Member lookup: every value of one member or channel.
CREATE INDEX data_values_owner ON data_values (owner_id) WHERE owner_id <> '';
