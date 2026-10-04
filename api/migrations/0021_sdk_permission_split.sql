-- SDK permissions split into finer ones (shared/sdk-permissions.json
-- "replaced"). A rule (allow/deny) set for an old coarse key now applies to
-- each of its replacements, unless that one has its own rule already; the
-- old rows go. Manifests that still name an old key are read with the new
-- keys (bot: catalog.expandPermissions, API: SdkCatalog::expand).

INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.members.nicknames', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.members.manage';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.roles.assign', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.members.manage';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.members.timeout', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.members.manage';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.members.kick', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.members.manage';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.members.ban', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.members.manage';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.messages.edit', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.messages.manage';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.messages.pin', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.messages.manage';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.messages.react', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.messages.manage';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.channels.write', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.channels.manage';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.channels.permissions', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.channels.manage';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.roles.write', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.roles.manage';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.roles.assign', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.roles.manage';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.voice.connect', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.voice';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.voice.speak', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.voice';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.voice.mute', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.voice.moderate';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.voice.move', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.voice.moderate';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'economy.read', enabled, updated_at FROM sdk_policies WHERE permission = 'economy';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'economy.write', enabled, updated_at FROM sdk_policies WHERE permission = 'economy';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.interactions.reply', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.interactions';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.modals', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.interactions';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'dashboard.read', enabled, updated_at FROM sdk_policies WHERE permission = 'dashboard.ui';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'dashboard.settings', enabled, updated_at FROM sdk_policies WHERE permission = 'dashboard.ui';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'dashboard.pages', enabled, updated_at FROM sdk_policies WHERE permission = 'dashboard.ui';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.events.messages', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.events';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.events.members', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.events';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.events.server', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.events';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.events.voice', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.events';
INSERT OR IGNORE INTO sdk_policies (permission, enabled, updated_at) SELECT 'discord.events.interactions', enabled, updated_at FROM sdk_policies WHERE permission = 'discord.events';

DELETE FROM sdk_policies WHERE permission IN ('discord.members.manage', 'discord.messages.manage', 'discord.channels.manage', 'discord.roles.manage', 'discord.voice', 'discord.voice.moderate', 'economy', 'discord.interactions', 'dashboard.ui', 'discord.events');
