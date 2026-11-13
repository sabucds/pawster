CREATE TABLE `digest_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`subscriber_id` text NOT NULL,
	`period` text NOT NULL,
	`sent_at` integer NOT NULL,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `digest_deliveries_sent_at_idx` ON `digest_deliveries` (`sent_at`);--> statement-breakpoint
ALTER TABLE `digest_runs` ADD `purged_deliveries` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `digest_runs` ADD `pruned_sent_rows` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `digest_runs` ADD `erased_departures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `digest_runs` ADD `sweep` text;--> statement-breakpoint
ALTER TABLE `digest_runs` ADD `reclaimed_objects` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `digest_runs` ADD `reclaimed_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `digest_runs` ADD `stored_bytes` integer;--> statement-breakpoint
ALTER TABLE `digest_sent` ADD `unlisted_since` integer;