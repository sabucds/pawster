ALTER TABLE `subscribers` ADD `unsubscribed_at` integer;--> statement-breakpoint
ALTER TABLE `subscribers` ADD `manage_token_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `subscribers` ADD `retired_at` integer;--> statement-breakpoint
ALTER TABLE `subscribers` ADD `retirement_reason` text;--> statement-breakpoint
ALTER TABLE `subscribers` ADD `nudged_at` integer;--> statement-breakpoint
CREATE INDEX `subscribers_unsubscribed_at_idx` ON `subscribers` (`unsubscribed_at`);--> statement-breakpoint
CREATE INDEX `subscribers_nudge_idx` ON `subscribers` (`nudged_at`,`last_digest_at`,`opted_in_at`);