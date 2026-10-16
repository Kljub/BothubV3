-- Mobile app: phones paired with an account (dashboard QR code). key_hash:
-- SHA-256 of the device token (the token itself is never stored);
-- public_key: the P-256 key of the phone's keystore that signs every
-- request. push_token and notify: for push notifications (later). guard:
-- BotHub Guard (second sign-in factor); guard_secret_enc: the key of the
-- app's Guard codes, encrypted like bot tokens.

CREATE TABLE mobile_devices (
    key_hash      TEXT PRIMARY KEY CHECK (length(key_hash) = 64),
    public_id     TEXT NOT NULL UNIQUE,
    user_id       INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
    platform      TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
    app_version   TEXT NOT NULL DEFAULT '',
    public_key    TEXT NOT NULL CHECK (length(public_key) <= 400),
    push_token    TEXT NOT NULL DEFAULT '',
    push_platform TEXT NOT NULL DEFAULT '',
    notify        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(notify)),
    guard         INTEGER NOT NULL DEFAULT 0 CHECK (guard IN (0, 1)),
    guard_secret_enc BLOB,
    ip            TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL
) STRICT;

CREATE INDEX mobile_devices_user ON mobile_devices (user_id);
