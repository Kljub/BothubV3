-- Look of a role in Users & Roles: a color and an icon from fixed lists
-- (the gateway checks them); empty = the default of the role.

ALTER TABLE roles ADD COLUMN color TEXT NOT NULL DEFAULT '' CHECK (length(color) <= 16);
ALTER TABLE roles ADD COLUMN icon TEXT NOT NULL DEFAULT '' CHECK (length(icon) <= 16);
