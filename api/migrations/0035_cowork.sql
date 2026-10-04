-- Co-Work invites and saved roles. An invite is a link (token, only its
-- hash is stored; optional expiry and use limit) or addressed to a user
-- (accepted or declined by them). Saved roles: named sets of rights per bot.
-- The activity of collaborators goes into logs (key log.cowork.*).

CREATE TABLE bot_invites (
    id          INTEGER PRIMARY KEY,
    bot_id      INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('link', 'user')),
    token_hash  TEXT UNIQUE, -- link: sha256 of the token
    user_id     INTEGER REFERENCES users (id) ON DELETE CASCADE, -- user: the invited user
    role        TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'builder', 'admin', 'custom')),
    permissions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(permissions)),
    role_name   TEXT NOT NULL DEFAULT '' CHECK (length(role_name) <= 40), -- a saved role it came from
    created_by  INTEGER,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at  TEXT, -- NULL = never
    max_uses    INTEGER NOT NULL DEFAULT 0 CHECK (max_uses >= 0), -- 0 = no limit
    uses        INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX bot_invites_bot ON bot_invites (bot_id);
CREATE INDEX bot_invites_user ON bot_invites (user_id);

CREATE TABLE bot_saved_roles (
    id          INTEGER PRIMARY KEY,
    bot_id      INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
    permissions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(permissions)),
    UNIQUE (bot_id, name)
) STRICT;
