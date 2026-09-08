-- `DEFAULT 0` is hand-added and the `UPDATE` below is not drizzle-kit's output at all, for
-- the same reason recorded at length in `0001_worried_the_spike.sql`: it generated
-- `ADD position integer NOT NULL` with no default, which SQLite accepts **only while the
-- table is empty**. With one row present it fails with `Cannot add a NOT NULL column with
-- default value NULL`, and a D1 migration gets no transaction to rebuild the table inside.
--
-- The default is a migration-time backfill and never an application-level one: `position`
-- is `.notNull()` with no `.default()` in `db/src/schema.ts`, so Drizzle requires it on
-- every insert and nothing in the codebase can reach the default.
--
-- Backfilling every pre-existing row to 0 would be wrong rather than merely coarse: a
-- shelter holding three contact points would have three of them claiming to be the one an
-- adopter is offered, and the ordering the column exists to carry would be decided by
-- whatever order SQLite happened to return. So the `UPDATE` numbers each shelter's points
-- 0, 1, 2… in the order they were inserted, counting earlier rows of the same shelter by
-- `rowid`. That is the order the registration form submitted them in, which is the closest
-- thing to the shelter's own intent that exists to recover.
ALTER TABLE `shelter_contact_points` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `shelter_contact_points` SET `position` = (
	SELECT COUNT(*) FROM `shelter_contact_points` AS `earlier`
	WHERE `earlier`.`shelter_id` = `shelter_contact_points`.`shelter_id`
	AND `earlier`.`rowid` < `shelter_contact_points`.`rowid`
);
