-- Runtime data of the modules whose blocks exist in the builder. Written by
-- the bot (plan.md: the bot writes runtime data, never configuration).
-- Module settings live in bot_modules.config. Later modules add their own
-- migrations.

-- Economy: several currencies per bot, one of them the default.
CREATE TABLE economy_currencies (
    id         INTEGER PRIMARY KEY,
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    key        TEXT NOT NULL CHECK (key GLOB '[a-z0-9]*' AND length(key) <= 32),
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
    symbol     TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    UNIQUE (bot_id, key)
) STRICT;

CREATE UNIQUE INDEX economy_currencies_default ON economy_currencies (bot_id) WHERE is_default = 1;

CREATE TABLE economy_balances (
    currency_id INTEGER NOT NULL REFERENCES economy_currencies (id) ON DELETE CASCADE,
    guild_id    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    balance     INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (currency_id, guild_id, user_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX economy_balances_rank ON economy_balances (currency_id, guild_id, balance DESC);

-- Moderation: warnings.
CREATE TABLE warnings (
    id           INTEGER PRIMARY KEY,
    bot_id       INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    moderator_id TEXT,
    reason       TEXT NOT NULL DEFAULT '' CHECK (length(reason) <= 500),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX warnings_user ON warnings (bot_id, guild_id, user_id);

-- Leveling.
CREATE TABLE leveling_members (
    bot_id        INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    xp            INTEGER NOT NULL DEFAULT 0 CHECK (xp >= 0),
    level         INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
    messages      INTEGER NOT NULL DEFAULT 0,
    voice_minutes INTEGER NOT NULL DEFAULT 0,
    last_xp_at    TEXT, -- message cooldown
    PRIMARY KEY (bot_id, guild_id, user_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX leveling_rank ON leveling_members (bot_id, guild_id, xp DESC);

-- Birthdays (year optional).
CREATE TABLE birthdays (
    bot_id   INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    month    INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    day      INTEGER NOT NULL CHECK (day BETWEEN 1 AND 31),
    year     INTEGER CHECK (year IS NULL OR year BETWEEN 1900 AND 2100),
    last_announced_year INTEGER,
    PRIMARY KEY (bot_id, guild_id, user_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX birthdays_date ON birthdays (bot_id, month, day);

-- Invite tracker: one row per join; stats are counted from it.
CREATE TABLE invite_joins (
    id         INTEGER PRIMARY KEY,
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    inviter_id TEXT, -- NULL = unknown (vanity URL, widget …)
    code       TEXT,
    fake       INTEGER NOT NULL DEFAULT 0 CHECK (fake IN (0, 1)), -- e.g. account too new
    joined_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    left_at    TEXT,
    reset_at   TEXT -- set by Invite Reset; reset joins no longer count
) STRICT;

CREATE INDEX invite_joins_inviter ON invite_joins (bot_id, guild_id, inviter_id);
CREATE INDEX invite_joins_member ON invite_joins (bot_id, guild_id, user_id);

-- Giveaways.
CREATE TABLE giveaways (
    id               INTEGER PRIMARY KEY,
    bot_id           INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id         TEXT NOT NULL,
    channel_id       TEXT NOT NULL,
    message_id       TEXT,
    host_id          TEXT,
    prize            TEXT NOT NULL CHECK (length(prize) BETWEEN 1 AND 200),
    winners          INTEGER NOT NULL DEFAULT 1 CHECK (winners BETWEEN 1 AND 50),
    required_role_id TEXT,
    ends_at          TEXT NOT NULL,
    ended_at         TEXT,
    winner_ids       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(winner_ids)),
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX giveaways_open ON giveaways (bot_id, ends_at) WHERE ended_at IS NULL;

CREATE TABLE giveaway_entries (
    giveaway_id INTEGER NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    entered_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (giveaway_id, user_id)
) STRICT, WITHOUT ROWID;

-- Polls.
CREATE TABLE polls (
    id         INTEGER PRIMARY KEY,
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id   TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    author_id  TEXT,
    question   TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 300),
    answers    TEXT NOT NULL CHECK (json_valid(answers) AND json_array_length(answers) BETWEEN 2 AND 10),
    multiple   INTEGER NOT NULL DEFAULT 0 CHECK (multiple IN (0, 1)),
    ends_at    TEXT,
    closed_at  TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX polls_bot ON polls (bot_id, guild_id);

CREATE TABLE poll_votes (
    poll_id  INTEGER NOT NULL REFERENCES polls (id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL,
    answer   INTEGER NOT NULL CHECK (answer BETWEEN 0 AND 9),
    voted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (poll_id, user_id, answer)
) STRICT, WITHOUT ROWID;

-- Suggestions.
CREATE TABLE suggestions (
    id          INTEGER PRIMARY KEY,
    bot_id      INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id    TEXT NOT NULL,
    number      INTEGER NOT NULL, -- per server, shown as #12
    channel_id  TEXT,
    message_id  TEXT,
    author_id   TEXT NOT NULL,
    content     TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    decided_by  TEXT,
    reason      TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    decided_at  TEXT,
    UNIQUE (bot_id, guild_id, number)
) STRICT;

CREATE TABLE suggestion_votes (
    suggestion_id INTEGER NOT NULL REFERENCES suggestions (id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL,
    vote          INTEGER NOT NULL CHECK (vote IN (-1, 1)),
    PRIMARY KEY (suggestion_id, user_id)
) STRICT, WITHOUT ROWID;

-- Tickets.
CREATE TABLE tickets (
    id           INTEGER PRIMARY KEY,
    bot_id       INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id     TEXT NOT NULL,
    number       INTEGER NOT NULL,
    channel_id   TEXT,
    opener_id    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'deleted')),
    closed_by    TEXT,
    close_reason TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    closed_at    TEXT,
    UNIQUE (bot_id, guild_id, number)
) STRICT;

CREATE INDEX tickets_channel ON tickets (bot_id, channel_id);

CREATE TABLE ticket_members (
    ticket_id INTEGER NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL,
    added_by  TEXT,
    added_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (ticket_id, user_id)
) STRICT, WITHOUT ROWID;

-- Modmail.
CREATE TABLE modmail_threads (
    id         INTEGER PRIMARY KEY,
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    thread_id  TEXT, -- channel or thread on the server
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    closed_at  TEXT,
    closed_by  TEXT
) STRICT;

CREATE UNIQUE INDEX modmail_threads_open ON modmail_threads (bot_id, guild_id, user_id) WHERE status = 'open';

CREATE TABLE modmail_blocks (
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    blocked_by TEXT,
    blocked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, guild_id, user_id)
) STRICT, WITHOUT ROWID;

-- Transcripts (HTML files under /data/uploads/transcripts).
CREATE TABLE transcripts (
    id            INTEGER PRIMARY KEY,
    bot_id        INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id      TEXT NOT NULL,
    channel_id    TEXT NOT NULL,
    file          TEXT NOT NULL, -- path relative to /data/uploads
    message_count INTEGER NOT NULL DEFAULT 0,
    created_by    TEXT,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX transcripts_bot ON transcripts (bot_id, guild_id);
