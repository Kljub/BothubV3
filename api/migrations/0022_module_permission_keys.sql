-- Module capabilities moved under modules.<module>.<area> (economy.* ->
-- modules.economy.*, moderation.cases -> modules.moderation.cases). Rules
-- move with them; manifests with the old keys are read with the new ones.

INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'modules.economy.balance.read', enabled, updated_at FROM sdk_policies WHERE permission = 'economy.read';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'modules.economy.balance.write', enabled, updated_at FROM sdk_policies WHERE permission = 'economy.write';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'modules.economy.transactions', enabled, updated_at FROM sdk_policies WHERE permission = 'economy.transactions';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'modules.economy.settings', enabled, updated_at FROM sdk_policies WHERE permission = 'economy.settings';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'modules.moderation.cases', enabled, updated_at FROM sdk_policies WHERE permission = 'moderation.cases';

DELETE FROM sdk_policies WHERE permission IN ('economy.read', 'economy.write', 'economy.transactions', 'economy.settings', 'moderation.cases');
