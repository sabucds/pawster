CREATE TABLE `verifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`shelter_id` text NOT NULL,
	`outcome` text NOT NULL,
	`methods` text NOT NULL,
	`evidence` text NOT NULL,
	`decided_at` integer NOT NULL,
	`decided_by` text NOT NULL,
	`cited_display_name` text NOT NULL,
	`cited_contact_points` text NOT NULL,
	FOREIGN KEY (`shelter_id`) REFERENCES `shelters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `verifications_shelter_idx` ON `verifications` (`shelter_id`,`id`);