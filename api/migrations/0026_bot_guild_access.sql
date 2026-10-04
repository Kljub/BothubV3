-- Closed invites per bot: while invites_closed is 1 the bot stays only on
-- the servers of bot_allowed_guilds and leaves any other server at once (on
-- join, at start and after a change). Lets a public, verified app run on
-- chosen servers only.

ALTER TABLE bots ADD COLUMN invites_closed INTEGER NOT NULL DEFAULT 0 CHECK (invites_closed IN (0, 1));

CREATE TABLE bot_allowed_guilds (
    bot_id   INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL CHECK (length(guild_id) BETWEEN 17 AND 20 AND guild_id NOT GLOB '*[^0-9]*'),
    added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, guild_id)
) STRICT, WITHOUT ROWID;
