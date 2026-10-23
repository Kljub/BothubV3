-- Web Verify (module "web-verify"): members verify on a dashboard page with
-- the bot's Discord sign-in. Discord never gives a bot the IP address of a
-- member, so the check runs on the page: Tor exit list, VPN/proxy/hosting
-- check (proxycheck.io, optional), country filter and a match against other
-- accounts that verified from the same address on the same server.

-- One verification link. The bot writes the row when a member presses the
-- panel button (token_hash: SHA-256 of the token in the link; the token
-- itself is never stored). The API fills the result, the bot applies it
-- (roles, kick or ban, log) and sets applied = 1.
-- status: open (no result yet, or "try again without VPN"), passed, review
-- (the server team decides in the log channel), blocked.
CREATE TABLE web_verify_requests (
    id          INTEGER PRIMARY KEY,
    bot_id      INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id    TEXT NOT NULL CHECK (length(guild_id) BETWEEN 17 AND 20),
    user_id     TEXT NOT NULL CHECK (length(user_id) BETWEEN 17 AND 20),
    token_hash  TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'passed', 'review', 'blocked')),
    reasons     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reasons)),
    matches     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(matches)),
    country     TEXT NOT NULL DEFAULT '',
    tries       INTEGER NOT NULL DEFAULT 0,
    applied     INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at  TEXT NOT NULL,
    done_at     TEXT
) STRICT;

CREATE INDEX web_verify_requests_todo ON web_verify_requests (bot_id, applied, status);

-- Addresses of verified members, never in plain text: HMAC-SHA-256 with a
-- key derived from the instance key and the server, so the same address
-- gives different values on different servers. Deleted after the module's
-- retention time.
CREATE TABLE web_verify_ips (
    bot_id   INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL CHECK (length(guild_id) BETWEEN 17 AND 20),
    ip_hash  TEXT NOT NULL CHECK (length(ip_hash) = 64),
    user_id  TEXT NOT NULL CHECK (length(user_id) BETWEEN 17 AND 20),
    seen_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (bot_id, guild_id, ip_hash, user_id)
) STRICT;

CREATE INDEX web_verify_ips_seen ON web_verify_ips (bot_id, seen_at);

-- Off on every existing bot: its first activation needs the owner's
-- confirmation that /privacy gets the Web Verify section.
INSERT OR IGNORE INTO bot_modules (bot_id, module_key, enabled) SELECT id, 'web-verify', 0 FROM bots;
