-- Bots, their servers (guilds), modules and plugins.

CREATE TABLE bots (
    id                INTEGER PRIMARY KEY,
    name              TEXT NOT NULL,
    application_id    TEXT, -- Discord application (snowflake)
    avatar_url        TEXT,
    -- The bot needs the token in clear text for the Discord login, so it is
    -- encrypted, not hashed. The API never returns it (tokenSet: true only).
    token_enc         BLOB,
    -- HMAC-SHA-256 with the instance salt: finds duplicate tokens without
    -- decrypting them.
    token_fingerprint BLOB UNIQUE,
    autostart         INTEGER NOT NULL DEFAULT 1 CHECK (autostart IN (0, 1)),
    -- Written by the bot: running, stopped, starting, error.
    status            TEXT NOT NULL DEFAULT 'stopped' CHECK (status IN ('running', 'stopped', 'starting', 'error')),
    status_error_key  TEXT,
    created_by        INTEGER REFERENCES users (id) ON DELETE SET NULL,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Bot profile and presence as set in the dashboard. Avatar and banner
-- changes are rate limited by Discord, the *_changed_at columns track that.
CREATE TABLE bot_profiles (
    bot_id            INTEGER PRIMARY KEY REFERENCES bots (id) ON DELETE CASCADE,
    avatar_url        TEXT,
    banner_url        TEXT,
    pronouns          TEXT NOT NULL DEFAULT '',
    bio               TEXT NOT NULL DEFAULT '' CHECK (length(bio) <= 190),
    avatar_changes    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(avatar_changes)), -- times of the last changes
    banner_changes    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(banner_changes)),
    -- {status, activity: {type, name, url}, customStatus, rotation: {enabled, intervalSeconds, entries}}
    presence          TEXT NOT NULL DEFAULT '{"status":"online"}' CHECK (json_valid(presence)),
    updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Servers the bot is in. Written by the bot (cache of Discord data).
CREATE TABLE bot_guilds (
    bot_id       INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id     TEXT NOT NULL,
    name         TEXT NOT NULL,
    icon_url     TEXT,
    member_count INTEGER NOT NULL DEFAULT 0,
    joined_at    TEXT,
    left_at      TEXT, -- NULL while the bot is in the server
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, guild_id)
) STRICT, WITHOUT ROWID;

-- Modules are per bot for all its servers (catalog: shared/modules.json).
-- config holds the module settings page; its shape belongs to the module.
CREATE TABLE bot_modules (
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    module_key TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    config     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, module_key)
) STRICT, WITHOUT ROWID;

-- Installed plugin versions (files under /data/plugins/<id>/<version>).
CREATE TABLE plugins (
    id           TEXT NOT NULL CHECK (id GLOB '[a-z0-9]*'),
    version      TEXT NOT NULL CHECK (version GLOB '[0-9]*.[0-9]*.[0-9]*'),
    sha256       TEXT NOT NULL CHECK (length(sha256) = 64),
    manifest     TEXT NOT NULL CHECK (json_valid(manifest)),
    installed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (id, version)
) STRICT, WITHOUT ROWID;

-- Plugins are installed and enabled per bot; the user grants the declared
-- permissions per bot.
CREATE TABLE bot_plugins (
    bot_id              INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    plugin_id           TEXT NOT NULL,
    version             TEXT NOT NULL,
    enabled             INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    granted_permissions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted_permissions) AND json_type(granted_permissions) = 'array'),
    config              TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config)),
    installed_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, plugin_id),
    FOREIGN KEY (plugin_id, version) REFERENCES plugins (id, version)
) STRICT, WITHOUT ROWID;
