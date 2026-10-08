-- Privileged gateway intents of a bot as the Discord Developer Portal has
-- them (written by the bot at each start): {"presence": bool, "members":
-- bool, "messageContent": bool, "at": "..."}. The builder warns about events
-- that need one that is off (e.g. a member's status change needs presence).

ALTER TABLE bots ADD COLUMN intents TEXT CHECK (intents IS NULL OR json_valid(intents));
