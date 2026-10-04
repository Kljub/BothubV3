-- Global secrets and API endpoints (admin tab "API / Secrets"), shared by all
-- bots. Secret values are AES-256-GCM ciphertext (SecretBox, like bot
-- tokens) and never leave the API or the bot: the dashboard only sees keys.
--
-- api_endpoints: a base URL plus an optional secret that the bot sends as an
-- auth header (bearer: "Bearer <value>", plain: "<value>"). The API Request
-- block can use an endpoint by key instead of a full URL.

CREATE TABLE secrets (
    key         TEXT PRIMARY KEY CHECK (length(key) BETWEEN 2 AND 40),
    value_enc   BLOB NOT NULL,
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 200),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT, WITHOUT ROWID;

CREATE TABLE api_endpoints (
    key         TEXT PRIMARY KEY CHECK (length(key) BETWEEN 2 AND 40),
    url         TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 500),
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 200),
    -- RESTRICT: a secret cannot be deleted while an endpoint uses it.
    secret_key  TEXT REFERENCES secrets (key) ON UPDATE CASCADE ON DELETE RESTRICT,
    auth_header TEXT NOT NULL DEFAULT 'Authorization',
    auth_scheme TEXT NOT NULL DEFAULT 'bearer' CHECK (auth_scheme IN ('bearer', 'plain')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT, WITHOUT ROWID;

-- Plugins read only secrets that were shared with them explicitly (SDK
-- permission secrets.read); no row = no access.
CREATE TABLE secret_plugin_shares (
    secret_key TEXT NOT NULL REFERENCES secrets (key) ON UPDATE CASCADE ON DELETE CASCADE,
    plugin_id  TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 100),
    shared_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (secret_key, plugin_id)
) STRICT, WITHOUT ROWID;
