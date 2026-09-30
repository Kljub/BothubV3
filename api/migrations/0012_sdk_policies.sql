-- Plugin model (user decision 2026-09-30): plugins are installed globally
-- for all bots; per bot a plugin can only be switched off. What plugins may
-- do is set globally by the SDK policies (admin > SDK Policies).
--
-- sdk_policies: one row per SDK permission (shared/sdk-permissions.json)
--   that the admin switched; a missing row uses the default of the file
--   (risk low = on, otherwise off).
-- plugin_installs: the installed version of each plugin (files under
--   /data/plugins/<id>/<version>), its global switch and settings.
-- bot_plugin_disabled: plugins switched off for one bot.
-- bot_plugins (0002, install per bot) is replaced and dropped.

CREATE TABLE sdk_policies (
    permission TEXT PRIMARY KEY CHECK (length(permission) BETWEEN 1 AND 64),
    enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT, WITHOUT ROWID;

CREATE TABLE plugin_installs (
    plugin_id    TEXT PRIMARY KEY,
    version      TEXT NOT NULL,
    enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    config       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config) AND json_type(config) = 'object'),
    installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (plugin_id, version) REFERENCES plugins (id, version)
) STRICT, WITHOUT ROWID;

CREATE TABLE bot_plugin_disabled (
    bot_id    INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    plugin_id TEXT NOT NULL REFERENCES plugin_installs (plugin_id) ON DELETE CASCADE,
    PRIMARY KEY (bot_id, plugin_id)
) STRICT, WITHOUT ROWID;

DROP TABLE bot_plugins;
