-- Small dashboard preferences per account, e.g. which module groups are
-- closed on the Modules page of each bot: {"moduleGroups": {"<botId>": ["utility", ...]}}.

ALTER TABLE users ADD COLUMN ui_prefs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ui_prefs) AND json_type(ui_prefs) = 'object');
