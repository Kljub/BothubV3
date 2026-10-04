-- Global storage of a plugin (SDK permission storage.global): one
-- key-value space per plugin for the whole instance, shared by every bot
-- (e.g. Discord user <-> Plex account links that hold across bots).
-- Quotas: shared/sdk-permissions.json limits.globalStorage*.

CREATE TABLE plugin_global_storage (
    plugin_id  TEXT NOT NULL CHECK (plugin_id GLOB '[a-z0-9]*' AND length(plugin_id) <= 64),
    key        TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
    value      TEXT NOT NULL CHECK (length(value) <= 16384),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (plugin_id, key)
) STRICT, WITHOUT ROWID;
