-- Auto Assign Roles: members link their Discord connections (Steam, GitHub,
-- Twitch …) once through the bot's own Discord sign-in (OAuth2 scopes
-- identify + connections). Discord never sends a bot these connections, so
-- the bot keeps the member's tokens (encrypted like bot tokens), reads the
-- connections again from time to time and gives roles by the module's rules.

-- The bot's OAuth2 app: the client secret of its Discord application and the
-- public address of the dashboard (for the link the bot posts).
CREATE TABLE bot_oauth_app (
    bot_id            INTEGER PRIMARY KEY REFERENCES bots (id) ON DELETE CASCADE,
    client_secret_enc BLOB NOT NULL,
    public_url        TEXT NOT NULL CHECK (length(public_url) BETWEEN 8 AND 300),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- One linked member per bot. connections: JSON [{type, id, name, verified}].
-- dirty = 1: the bot gives the roles again and fires "connections changed".
CREATE TABLE member_connections (
    bot_id      INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL CHECK (length(user_id) BETWEEN 17 AND 20),
    user_name   TEXT NOT NULL CHECK (length(user_name) BETWEEN 1 AND 64),
    access_enc  BLOB NOT NULL,
    refresh_enc BLOB NOT NULL,
    expires_at  TEXT NOT NULL,
    connections TEXT NOT NULL DEFAULT '[]',
    previous    TEXT NOT NULL DEFAULT '[]',
    dirty       INTEGER NOT NULL DEFAULT 1 CHECK (dirty IN (0, 1)),
    failures    INTEGER NOT NULL DEFAULT 0,
    linked_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    checked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, user_id)
) STRICT;

CREATE INDEX member_connections_dirty ON member_connections (bot_id, dirty);
