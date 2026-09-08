-- Hand-written, and drizzle-kit's output for this change is discarded rather than edited —
-- the same posture, for a related reason, as `0001_worried_the_spike.sql` and
-- `0002_ordinary_rick_jones.sql`.
--
-- It generated the standard SQLite rebuild (create `__new_animals`, copy, drop, rename), but
-- its copy step reads the *new* columns out of the *old* table:
--
--   INSERT INTO `__new_animals`(..., "upload_session_id", "sex", "description", ...)
--   SELECT ..., "upload_session_id", "sex", "description", ... FROM `animals`;
--
-- `animals` has seven columns as of `0000_init`, so that statement fails with
-- `no such column: upload_session_id` on every database the table exists in. Nor can it be
-- repaired by supplying values for the new columns: `upload_session_id` must reference a real
-- `upload_sessions` row, and there is no session that an already-published animal could have
-- been assembled from — the whole point of ADR 0012 is that the session comes first.
--
-- So the table is dropped and rebuilt empty, which is sound here for a reason worth stating
-- rather than assuming: **no code has ever inserted an animal.** Issue #55 adds the first
-- write path, and the only `insert(animals)` calls in the repository before it are in
-- `web/test/`, against a database each test builds from these migrations and then throws
-- away. A deployed `animals` table is therefore provably empty, and carrying zero rows
-- through a rebuild is ceremony that only adds a statement able to fail.
--
-- The two CHECKs are written with bare column names rather than the qualified
-- `"animals"."species"` drizzle-kit emits, so the expressions do not name the table they live
-- in and cannot be left dangling by a later rebuild or rename.
DROP TABLE `animals`;--> statement-breakpoint
CREATE TABLE `animals` (
	`id` text PRIMARY KEY NOT NULL,
	`shelter_id` text NOT NULL,
	`name` text NOT NULL,
	`species` text NOT NULL,
	`estimated_birth_date` integer NOT NULL,
	`region` text NOT NULL,
	`last_confirmed_at` integer NOT NULL,
	`upload_session_id` text NOT NULL,
	`sex` text NOT NULL,
	`size` text,
	`age_estimate_basis` text NOT NULL,
	`good_with_children` text NOT NULL,
	`good_with_dogs` text NOT NULL,
	`good_with_cats` text NOT NULL,
	`description` text NOT NULL,
	`medical_needs` text,
	`sterilisation` text NOT NULL,
	`availability` text NOT NULL,
	`matchable_since` integer NOT NULL,
	`urgent_reason` text,
	FOREIGN KEY (`shelter_id`) REFERENCES `shelters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`upload_session_id`) REFERENCES `upload_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "animals_size_is_dog_only" CHECK((`species` = 'dog') = (`size` is not null)),
	CONSTRAINT "animals_urgent_reason_not_blank" CHECK(`urgent_reason` is null or length(trim(`urgent_reason`)) > 0)
);
--> statement-breakpoint
CREATE INDEX `animals_shelter_idx` ON `animals` (`shelter_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `animals_upload_session_idx` ON `animals` (`upload_session_id`);
