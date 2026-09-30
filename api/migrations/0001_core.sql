-- Core: instance settings, users and roles, sign-in methods, logs, outbox.
--
-- Conventions for every migration:
--   * STRICT tables, INTEGER PRIMARY KEY ids.
--   * Times are UTC ISO-8601 text (strftime('%Y-%m-%dT%H:%M:%fZ')).
--   * Discord IDs (snowflakes) are TEXT: they do not fit a JS number.
--   * JSON columns are TEXT with CHECK (json_valid(...)); only the
--     repository layer of API and bot parses them.
--   * Secrets are AES-256-GCM ciphertext (nonce || ciphertext || tag) in BLOB
--     columns ending in _enc. They never leave the API or the bot.

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL CHECK (json_valid(value)),
    secret_enc BLOB, -- e.g. the SMTP password of key 'smtp'
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE roles (
    id          INTEGER PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE CHECK (key GLOB '[a-z]*' AND length(key) <= 32),
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
    builtin     INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
    permissions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(permissions) AND json_type(permissions) = 'array'),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO roles (key, name, builtin, permissions) VALUES
    ('admin', 'Admin', 1, '["admin.access","users.manage","bots.create","bots.manage","bots.view","modules.manage","plugins.manage","logs.view"]'),
    ('member', 'Member', 1, '["bots.view"]');

CREATE TABLE users (
    id                 INTEGER PRIMARY KEY,
    username           TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(username) BETWEEN 3 AND 32),
    email              TEXT COLLATE NOCASE,
    password_hash      TEXT NOT NULL, -- Argon2id, salt included
    role_id            INTEGER NOT NULL REFERENCES roles (id),
    locale             TEXT NOT NULL DEFAULT 'en',
    theme              TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark', 'light', 'system')),
    totp_secret_enc    BLOB, -- active 2FA secret; NULL = 2FA off
    totp_pending_enc   BLOB, -- set by 2FA setup, active after confirmation
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_login_at      TEXT,
    password_changed_at TEXT
) STRICT;

CREATE UNIQUE INDEX users_email ON users (email) WHERE email IS NOT NULL;

-- One-time 2FA recovery codes, stored hashed.
CREATE TABLE user_recovery_codes (
    user_id   INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at   TEXT,
    PRIMARY KEY (user_id, code_hash)
) STRICT;

-- WebAuthn credentials. credential holds the library's serialized credential
-- (public key, sign count, flags, transports).
CREATE TABLE passkeys (
    id           TEXT PRIMARY KEY, -- base64url credential ID
    user_id      INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    credential   TEXT NOT NULL CHECK (json_valid(credential)),
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_used_at TEXT
) STRICT;

CREATE INDEX passkeys_user ON passkeys (user_id);

-- Instance log (bot_id NULL) and bot logs. Codes: shared/log-codes.json.
-- bot_id has no foreign key: the log of a deleted bot stays readable.
CREATE TABLE logs (
    id            INTEGER PRIMARY KEY,
    bot_id        INTEGER,
    at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    level         TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
    code          TEXT,
    key           TEXT NOT NULL, -- i18n key of the message
    params        TEXT CHECK (params IS NULL OR json_valid(params)),
    change        TEXT CHECK (change IS NULL OR json_valid(change)), -- {field, old, new}
    source        TEXT, -- api, bot, dashboard, plugin:<id>
    actor_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL
) STRICT;

CREATE INDEX logs_bot_at ON logs (bot_id, at DESC);

-- Transactional outbox: the API writes a change and its event in one
-- transaction; the relay moves open rows to the Redis stream and sets sent_at.
CREATE TABLE outbox (
    id         INTEGER PRIMARY KEY,
    stream     TEXT NOT NULL DEFAULT 'bothub:events',
    type       TEXT NOT NULL, -- e.g. command.saved, bot.token_changed
    payload    TEXT NOT NULL CHECK (json_valid(payload)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    sent_at    TEXT,
    attempts   INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX outbox_open ON outbox (id) WHERE sent_at IS NULL;
