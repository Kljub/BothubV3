-- Bot limits per role (Users & Roles): {"maxBots": n, "maxRunning": n,
-- "idleStopHours": n}; a missing key means no limit. Admins have none.
-- bots.last_active_at: last use of a bot (command, button, start), for the
-- idle stop of the limits.

ALTER TABLE roles ADD COLUMN limits TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(limits) AND json_type(limits) = 'object');
ALTER TABLE bots ADD COLUMN last_active_at TEXT;
