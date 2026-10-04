-- Data Storage variables a plugin created (SDK variables.create): plugin_id
-- names the plugin, NULL for variables made on the dashboard. Builders and
-- messages use them like any other variable ({var.<key>}); only the plugin
-- changes or deletes their definition, and they go when it is uninstalled.

ALTER TABLE data_variables ADD COLUMN plugin_id TEXT CHECK (plugin_id IS NULL OR length(plugin_id) BETWEEN 1 AND 100);
