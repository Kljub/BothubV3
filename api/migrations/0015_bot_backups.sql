-- Bot backups and templates (bot settings page). data is the export of
-- api/src/Internal/BotBackup.php: the configuration of one bot (commands,
-- events, groups, modules, timed events, message templates, Data Storage
-- variables, webhooks, presence, plugin settings), never the token,
-- secrets, logs or stored values.
--
-- kind 'backup':   belongs to one bot (bot_id); listed only there.
--                  auto = 1: made by the server right before a restore.
-- kind 'template': global, every bot can load it.
-- Ready-made templates ship as files (shared/bot-templates/*.json), not rows.

CREATE TABLE bot_templates (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('backup', 'template')),
    bot_id      INTEGER REFERENCES bots (id) ON DELETE CASCADE,
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 300),
    auto        INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0, 1)),
    data        TEXT NOT NULL CHECK (json_valid(data)),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (kind = 'template' OR bot_id IS NOT NULL)
) STRICT;

CREATE INDEX bot_templates_bot ON bot_templates (bot_id, created_at DESC);
