-- Plugin template (context/plugin-template-plan.md): plugins may ship slash
-- commands; they are copied into Custom Commands as disabled copies with
-- their origin, so an update adds new ones and uninstall can remove them.
-- plugin_settings holds each bot's settings of a plugin (validated against
-- the settings block of its manifest; read-only for the plugin).

ALTER TABLE commands ADD COLUMN plugin_id TEXT;
ALTER TABLE commands ADD COLUMN plugin_version TEXT;
ALTER TABLE commands ADD COLUMN preset_name TEXT; -- file name under commands/ (without .json)

CREATE INDEX commands_plugin ON commands (bot_id, plugin_id, preset_name) WHERE plugin_id IS NOT NULL;

CREATE TABLE plugin_settings (
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    plugin_id  TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 2 AND 64),
    config     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config) AND json_type(config) = 'object'),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, plugin_id)
) STRICT, WITHOUT ROWID;
