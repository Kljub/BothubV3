-- The Node Editor module is removed; it comes back later as a plugin.
-- Its module switch, settings and SDK rule go with it.

DELETE FROM bot_modules WHERE module_key = 'node-editor';
DELETE FROM sdk_policies WHERE permission = 'modules.node-editor.read';
