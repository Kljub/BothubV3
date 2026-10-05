-- Economy: a currency may allow balances below zero (debts). Off by default.

ALTER TABLE economy_currencies ADD COLUMN allow_negative INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative IN (0, 1));
