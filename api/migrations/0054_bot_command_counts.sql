-- Commands of a bot as registered at Discord, written by the bot at each
-- registration: {slash, user, message, groups: {"<module key>" or
-- "plugin:<id>": active commands}, at}. Shown next to the module groups and
-- in the top bar (slash / 100). NULL until the bot registered once.

ALTER TABLE bots ADD COLUMN command_counts TEXT CHECK (command_counts IS NULL OR json_valid(command_counts));
