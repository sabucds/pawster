CREATE TABLE `shelter_contact_points` (
	`id` text PRIMARY KEY NOT NULL,
	`shelter_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`shelter_id`) REFERENCES `shelters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shelter_contact_points_shelter_idx` ON `shelter_contact_points` (`shelter_id`);--> statement-breakpoint
CREATE TABLE `one_time_codes` (
	`shelter_id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`request_token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts_used` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`shelter_id`) REFERENCES `shelters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_time_codes_request_token_unique` ON `one_time_codes` (`request_token`);--> statement-breakpoint
CREATE TABLE `sign_in_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`shelter_id` text,
	`ip_hash` text NOT NULL,
	`mail_sent` integer NOT NULL,
	`requested_at` integer NOT NULL,
	FOREIGN KEY (`shelter_id`) REFERENCES `shelters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sign_in_requests_requested_at_idx` ON `sign_in_requests` (`requested_at`);--> statement-breakpoint
CREATE INDEX `sign_in_requests_ip_idx` ON `sign_in_requests` (`ip_hash`,`requested_at`);--> statement-breakpoint
CREATE INDEX `sign_in_requests_shelter_idx` ON `sign_in_requests` (`shelter_id`,`requested_at`);--> statement-breakpoint
-- `DEFAULT ''` on the next two columns is hand-added, and the `UPDATE` below is not
-- drizzle-kit's output at all. It generated `ADD <col> text NOT NULL` with no default,
-- which SQLite accepts **only while the table is empty**: with one row present it fails
-- with `Cannot add a NOT NULL column with default value NULL`, because a NOT NULL column
-- added by ALTER must carry a non-NULL default. Measured both ways on SQLite 3.43.2.
--
-- No deployed database has rows yet (issue #67 is the first public deploy), so the
-- generated form would have applied here and then failed on the first local database
-- anyone had registered a shelter against. A twelve-step table rebuild was the other
-- candidate and is worse: `DROP TABLE shelters` trips `animals`' foreign key, and the
-- `PRAGMA defer_foreign_keys` that would suspend it only holds inside a transaction, which
-- a D1 migration does not get. Adding the column with a default touches no foreign key,
-- needs no transaction, and is correct whether the table holds nothing or everything.
--
-- The default is therefore a migration-time backfill and never an application-level one:
-- `slug` and `base_region` are `.notNull()` with no `.default()` in `db/src/schema.ts`, so
-- Drizzle requires both on every insert and nothing in the codebase can reach these. The
-- one divergence that leaves — the live table permits an empty slug that the schema's types
-- do not — is why the `UPDATE` exists: it moves every pre-existing row off `''` and onto its
-- own id, which is already unique, so the unique index below can be created at all. Two
-- rows sharing `''` would have collided on it.
ALTER TABLE `shelters` ADD `slug` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `shelters` ADD `base_region` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `shelters` ADD `session_epoch` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `shelters` SET `slug` = `id` WHERE `slug` = '';--> statement-breakpoint
CREATE UNIQUE INDEX `shelters_slug_unique` ON `shelters` (`slug`);
