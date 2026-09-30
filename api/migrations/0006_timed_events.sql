-- Timed events: schedules per bot that start custom events of type "timed"
-- (shared/events.json). A custom event picks its schedule in the builder
-- (trigger.event config timed_event = timed_events.id).
--
-- kind 'interval': every interval_seconds (at least 10), counted from
--   last_run_at (or from when the bot starts).
-- kind 'schedule': at each time of day in times, e.g. ["08:00:00","20:30:00"].
-- weekdays limits both kinds: JSON array of 0 = Sunday … 6 = Saturday;
--   an empty array means every day. Times and weekdays use the bot's
--   time zone (bots.timezone, IANA name; empty = the server's TZ).

ALTER TABLE bots ADD COLUMN timezone TEXT NOT NULL DEFAULT '' CHECK (length(timezone) <= 64);
-- {DEFAULT_SERVER} in blocks, and the server context of timed runs.
ALTER TABLE bots ADD COLUMN default_guild_id TEXT;

CREATE TABLE timed_events (
    id               INTEGER PRIMARY KEY,
    bot_id           INTEGER NOT NULL REFERENCES bots (id) ON DELETE CASCADE,
    name             TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    kind             TEXT NOT NULL CHECK (kind IN ('interval', 'schedule')),
    interval_seconds INTEGER CHECK (interval_seconds IS NULL OR interval_seconds BETWEEN 10 AND 31536000),
    times            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(times)),
    weekdays         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(weekdays)),
    enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    last_run_at      TEXT, -- written by the bot
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (kind = 'schedule' OR interval_seconds IS NOT NULL)
) STRICT;

CREATE INDEX timed_events_bot ON timed_events (bot_id);
