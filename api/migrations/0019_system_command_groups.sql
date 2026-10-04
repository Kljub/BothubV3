-- Command groups that hold module or plugin copies are system groups: the
-- dashboard does not list them in the group dialog or the "move to group"
-- menu, and the API refuses to rename, delete or fill them by hand. The
-- module and plugin pages find their copies by preset_name.

ALTER TABLE command_groups ADD COLUMN system INTEGER NOT NULL DEFAULT 0 CHECK (system IN (0, 1));

UPDATE command_groups SET system = 1
WHERE EXISTS (
    SELECT 1 FROM commands c
    WHERE c.group_id = command_groups.id AND (c.preset_name IS NOT NULL OR c.plugin_id IS NOT NULL)
);
