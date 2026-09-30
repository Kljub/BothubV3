-- Moderation module: cases and moderator notes. Written by the bot.
-- Settings of the module live in bot_modules.config (module_key
-- 'moderation'); timed undo (temp ban, temp role) uses scheduled_jobs.

-- One case per moderation action. number counts per server and is shown as
-- "Case #12". removed_at hides a case from the history (Remove Case block).
CREATE TABLE mod_cases (
    id           INTEGER PRIMARY KEY,
    bot_id       INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id     TEXT NOT NULL,
    number       INTEGER NOT NULL,
    user_id      TEXT NOT NULL,
    moderator_id TEXT,
    action       TEXT NOT NULL CHECK (action IN ('warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'role_add', 'role_remove', 'voice_mute', 'voice_unmute', 'voice_deafen', 'voice_undeafen', 'voice_kick')),
    reason       TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 512),
    duration     TEXT NOT NULL DEFAULT '' CHECK (length(duration) <= 20), -- e.g. 1h for timeout, temp ban, temp role
    auto         INTEGER NOT NULL DEFAULT 0 CHECK (auto IN (0, 1)), -- set by an automatic punishment
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    removed_at   TEXT,
    UNIQUE (bot_id, guild_id, number)
) STRICT;

CREATE INDEX mod_cases_user ON mod_cases (bot_id, guild_id, user_id) WHERE removed_at IS NULL;

-- Moderator notes about a member (only moderators see them).
CREATE TABLE mod_notes (
    id         INTEGER PRIMARY KEY,
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    author_id  TEXT,
    content    TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 1000),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX mod_notes_user ON mod_notes (bot_id, guild_id, user_id);
