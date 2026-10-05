-- Card Designer: image cards of a bot (welcome, goodbye, boost, milestone,
-- rank, own). design is the JSON the Card Studio edits and the bot draws
-- (shared/cards/render.mjs); modules point to a card by its ID.

CREATE TABLE bot_cards (
    id         INTEGER PRIMARY KEY,
    bot_id     INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    kind       TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('welcome', 'welcome-back', 'goodbye', 'boost', 'milestone', 'rank', 'custom')),
    design     TEXT NOT NULL CHECK (json_valid(design) AND json_type(design) = 'object' AND length(design) <= 262144),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX bot_cards_bot ON bot_cards (bot_id);
