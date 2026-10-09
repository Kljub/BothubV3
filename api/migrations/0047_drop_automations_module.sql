-- The Automations module is removed: Custom Events (event builder) does the
-- same and more. Its module switch, settings and SDK rule go with it.

DELETE FROM bot_modules WHERE module_key = 'automations';
DELETE FROM sdk_policies WHERE permission = 'modules.automations.read';
