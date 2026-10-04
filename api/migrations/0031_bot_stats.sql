-- Usage numbers of the bot overview, per server and hour (UTC, "YYYY-MM-DDTHH").
-- metric: joins, leaves, messages, voice_minutes, mod_commands, mod_automod,
-- commands, plugin_uses, and the top lists cmd:<command>, plugin:<id>,
-- mod:<action>. bot_stat_users: who was active in an hour (messages,
-- commands, voice), for "active users". The bot keeps 35 days.

CREATE TABLE bot_stats (
    bot_id   INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL CHECK (length(guild_id) BETWEEN 1 AND 20),
    hour     TEXT NOT NULL CHECK (length(hour) = 13),
    metric   TEXT NOT NULL CHECK (length(metric) BETWEEN 1 AND 120),
    value    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (bot_id, guild_id, hour, metric)
) STRICT, WITHOUT ROWID;

CREATE INDEX bot_stats_hour ON bot_stats (bot_id, hour);

CREATE TABLE bot_stat_users (
    bot_id   INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL CHECK (length(guild_id) BETWEEN 1 AND 20),
    hour     TEXT NOT NULL CHECK (length(hour) = 13),
    user_id  TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 20),
    PRIMARY KEY (bot_id, guild_id, hour, user_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX bot_stat_users_hour ON bot_stat_users (bot_id, hour);
