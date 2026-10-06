-- Twitch Alerts: the Twitch channel a bot listens to (follows, subs, raids,
-- bits through EventSub). The channel owner signs in with Twitch once; the
-- tokens are stored encrypted like bot tokens and refreshed by the bot.

CREATE TABLE bot_twitch_auth (
    bot_id       INTEGER PRIMARY KEY REFERENCES bots (id) ON DELETE CASCADE,
    twitch_id    TEXT NOT NULL CHECK (length(twitch_id) BETWEEN 1 AND 32),
    login        TEXT NOT NULL CHECK (length(login) BETWEEN 1 AND 32),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 64),
    scopes       TEXT NOT NULL,
    access_enc   BLOB NOT NULL,
    refresh_enc  BLOB NOT NULL,
    expires_at   TEXT NOT NULL,
    connected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
