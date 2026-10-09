-- Recovery key of the instance: lets the owner of the server get the admin
-- account back with the PHP CLI (start-app recover-admin) when its password,
-- 2FA and passkeys are lost. Only the hash is kept; the key is shown once
-- when it is created and works once.

CREATE TABLE recovery_key (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    key_hash   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_by TEXT NOT NULL DEFAULT ''
) STRICT;
