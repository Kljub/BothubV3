-- Card Designer: pictures the bot owner uploaded ("Your pictures") for card
-- backgrounds and image layers; a design points to one as "asset:<id>".

CREATE TABLE bot_card_images (
    id         INTEGER PRIMARY KEY,
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    mime       TEXT NOT NULL CHECK (mime IN ('image/png', 'image/gif', 'image/webp', 'image/jpeg')),
    size       INTEGER NOT NULL CHECK (size BETWEEN 1 AND 2097152),
    data       BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX bot_card_images_bot ON bot_card_images (bot_id);
