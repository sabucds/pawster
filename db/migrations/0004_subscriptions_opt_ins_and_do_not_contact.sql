CREATE TABLE `do_not_contact` (
	`digest` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`recorded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `opt_in_mails` (
	`id` text PRIMARY KEY NOT NULL,
	`email_hash` text NOT NULL,
	`sent_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `opt_in_mails_sent_at_idx` ON `opt_in_mails` (`sent_at`);--> statement-breakpoint
CREATE INDEX `opt_in_mails_email_idx` ON `opt_in_mails` (`email_hash`,`sent_at`);--> statement-breakpoint
CREATE TABLE `pending_opt_ins` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`criteria` text NOT NULL,
	`locale` text NOT NULL,
	`ip_hash` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pending_opt_ins_ip_idx` ON `pending_opt_ins` (`ip_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `pending_opt_ins_created_at_idx` ON `pending_opt_ins` (`created_at`);--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`subscriber_id` text NOT NULL,
	`slot` integer NOT NULL,
	`criteria` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "subscriptions_slot_range" CHECK("subscriptions"."slot" between 0 and 2)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_slot_idx` ON `subscriptions` (`subscriber_id`,`slot`);--> statement-breakpoint
ALTER TABLE `subscribers` ADD `locale` text DEFAULT 'es' NOT NULL;