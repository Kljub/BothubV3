-- Secrets per user: every user keeps their own API keys (User settings →
-- API / Secrets); a bot and its plugins use the keys of the bot's owner.
-- owner_id 0 is the instance itself (Admin → API / Secrets: the market
-- GitHub token). Users live in the auth layer, so owner_id is a plain ID
-- without a foreign key; existing secrets and bots go to the first user (the
-- admin of the setup).

ALTER TABLE bots ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 1 CHECK (owner_id >= 1);

CREATE TABLE secrets_new (
    owner_id    INTEGER NOT NULL CHECK (owner_id >= 0),
    key         TEXT NOT NULL CHECK (length(key) BETWEEN 2 AND 40),
    value_enc   BLOB NOT NULL,
    description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 200),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (owner_id, key)
) STRICT, WITHOUT ROWID;

INSERT INTO secrets_new (owner_id, key, value_enc, description, created_at, updated_at)
SELECT CASE WHEN key = 'MARKET_GITHUB_TOKEN' THEN 0 ELSE 1 END, key, value_enc, description, created_at, updated_at FROM secrets;

-- Plugins read only the secrets their bot's owner shared with them.
CREATE TABLE secret_plugin_shares_new (
    owner_id   INTEGER NOT NULL CHECK (owner_id >= 1),
    secret_key TEXT NOT NULL,
    plugin_id  TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 100),
    shared_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (owner_id, secret_key, plugin_id),
    FOREIGN KEY (owner_id, secret_key) REFERENCES secrets_new (owner_id, key) ON UPDATE CASCADE ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

INSERT INTO secret_plugin_shares_new (owner_id, secret_key, plugin_id, shared_at)
SELECT 1, secret_key, plugin_id, shared_at FROM secret_plugin_shares WHERE secret_key <> 'MARKET_GITHUB_TOKEN';

DROP TABLE secret_plugin_shares;
DROP TABLE secrets;
ALTER TABLE secrets_new RENAME TO secrets;
ALTER TABLE secret_plugin_shares_new RENAME TO secret_plugin_shares;
