-- Sign-in sessions of the gateway, so they survive restarts and updates.
-- key_hash: SHA-256 of the session cookie (the cookie itself is never
-- stored). remember: "stay signed in" (long-lived cookie). device_key: the
-- public key (SPKI, base64url) of a non-extractable key the browser made at
-- sign-in; the gateway asks for a signature with it now and then, so a
-- copied cookie alone does not work on another device.

CREATE TABLE user_sessions (
    key_hash     TEXT PRIMARY KEY CHECK (length(key_hash) = 64),
    public_id    TEXT NOT NULL UNIQUE,
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    csrf         TEXT NOT NULL,
    remember     INTEGER NOT NULL DEFAULT 0 CHECK (remember IN (0, 1)),
    device_key   TEXT,
    user_agent   TEXT NOT NULL DEFAULT '',
    ip           TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL
) STRICT;

CREATE INDEX user_sessions_user ON user_sessions (user_id);
