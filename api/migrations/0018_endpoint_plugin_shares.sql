-- The admin shares global API endpoints with a plugin (manifest
-- "endpoints"); ctx.http.endpoint(key) only works for a shared endpoint.
-- Sharing is per endpoint: the plugin never sees the secret behind it.

CREATE TABLE endpoint_plugin_shares (
    endpoint_key TEXT NOT NULL REFERENCES api_endpoints (key) ON UPDATE CASCADE ON DELETE CASCADE,
    plugin_id    TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 2 AND 64),
    shared_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (endpoint_key, plugin_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX endpoint_plugin_shares_plugin ON endpoint_plugin_shares (plugin_id);
