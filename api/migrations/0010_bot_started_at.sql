-- When the bot went online (Discord ready); NULL while it is not running.
-- Written by the bot, shown as uptime on the bot overview.
ALTER TABLE bots ADD COLUMN started_at TEXT;
