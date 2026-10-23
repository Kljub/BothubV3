-- Sign in with Discord: a user links their Discord account in the account
-- settings; the admin adds an own Discord application for the sign-in
-- (settings key "discord", client secret in secret_enc).
-- trusted_ips: hashes of addresses that finished a sign-in with 2FA or a
-- passkey ({hash: last time}); a Discord sign-in from such an address skips
-- 2FA when the admin allows it. Never the addresses themselves.

ALTER TABLE users ADD COLUMN discord_id TEXT CHECK (discord_id IS NULL OR length(discord_id) BETWEEN 17 AND 20);
ALTER TABLE users ADD COLUMN discord_name TEXT CHECK (discord_name IS NULL OR length(discord_name) <= 40);
ALTER TABLE users ADD COLUMN trusted_ips TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(trusted_ips));

CREATE UNIQUE INDEX users_discord_id ON users (discord_id) WHERE discord_id IS NOT NULL;
