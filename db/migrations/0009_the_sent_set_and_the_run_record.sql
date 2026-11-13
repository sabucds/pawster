CREATE TABLE `digest_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`period` text NOT NULL,
	`ran_at` integer NOT NULL,
	`shard` integer NOT NULL,
	`enqueued` integer NOT NULL,
	`units` integer NOT NULL,
	`nudged` integer NOT NULL,
	`purged_opt_ins` integer NOT NULL,
	`purged_opt_in_mails` integer NOT NULL,
	`erased_subscribers` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `digest_sent` (
	`subscription_id` text NOT NULL,
	`animal_id` text NOT NULL,
	`sent_at` integer NOT NULL,
	PRIMARY KEY(`subscription_id`, `animal_id`),
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`animal_id`) REFERENCES `animals`(`id`) ON UPDATE no action ON DELETE cascade
);
