-- Co-Work: other users who work on a bot (besides its owner). role: a
-- preset (viewer, operator, builder, admin) or custom; permissions: the
-- list of a custom role (the gateway knows the presets). The owner and
-- instance admins always have every right.

CREATE TABLE bot_members (
    bot_id      INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'builder', 'admin', 'custom')),
    permissions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(permissions) AND json_type(permissions) = 'array'),
    added_by    INTEGER,
    added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, user_id)
) STRICT;

CREATE INDEX bot_members_user ON bot_members (user_id);
