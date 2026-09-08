CREATE TABLE `storage_measurements` (
	`id` text PRIMARY KEY NOT NULL,
	`total_bytes` integer NOT NULL,
	`mode` text NOT NULL,
	`measured_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `storage_measurements_measured_at_idx` ON `storage_measurements` (`measured_at`);--> statement-breakpoint
CREATE TABLE `transformation_spends` (
	`id` text PRIMARY KEY NOT NULL,
	`transformations` integer NOT NULL,
	`spent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `transformation_spends_spent_at_idx` ON `transformation_spends` (`spent_at`);--> statement-breakpoint
CREATE TABLE `upload_session_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`source_digest` text NOT NULL,
	`original_key` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `upload_sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `upload_session_photos_session_idx` ON `upload_session_photos` (`session_id`,`position`);--> statement-breakpoint
CREATE INDEX `upload_session_photos_digest_idx` ON `upload_session_photos` (`source_digest`);--> statement-breakpoint
CREATE TABLE `upload_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`shelter_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`shelter_id`) REFERENCES `shelters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `upload_sessions_shelter_idx` ON `upload_sessions` (`shelter_id`);