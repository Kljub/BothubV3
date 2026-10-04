-- Economy module extras: the bank (money that earns interest, per currency,
-- server and member; interest is added when the bank is used, for every full
-- day since interest_at) and the inventory of shop items (item = key of an
-- item of the module settings).

CREATE TABLE economy_bank (
    currency_id INTEGER NOT NULL REFERENCES economy_currencies (id) ON DELETE CASCADE,
    guild_id    TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    amount      INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
    interest_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (currency_id, guild_id, user_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE economy_inventory (
    bot_id   INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    item     TEXT NOT NULL CHECK (length(item) BETWEEN 1 AND 32),
    qty      INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0),
    PRIMARY KEY (bot_id, guild_id, user_id, item)
) STRICT, WITHOUT ROWID;
