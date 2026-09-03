CREATE TABLE `animals` (
	`id` text PRIMARY KEY NOT NULL,
	`shelter_id` text NOT NULL,
	`name` text NOT NULL,
	`species` text NOT NULL,
	`estimated_birth_date` integer NOT NULL,
	`region` text NOT NULL,
	`last_confirmed_at` integer NOT NULL,
	`listed` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`shelter_id`) REFERENCES `shelters`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `animals_shelter_idx` ON `animals` (`shelter_id`);--> statement-breakpoint
CREATE TABLE `shelters` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`account_email` text NOT NULL,
	`country_code` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shelters_account_email_unique` ON `shelters` (`account_email`);--> statement-breakpoint
CREATE TABLE `subscribers` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`send_day` integer NOT NULL,
	`opted_in_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscribers_email_unique` ON `subscribers` (`email`);--> statement-breakpoint
CREATE INDEX `subscribers_send_day_idx` ON `subscribers` (`send_day`);