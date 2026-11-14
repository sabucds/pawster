ALTER TABLE `animals` ADD `last_confirmed_via` text DEFAULT 'session' NOT NULL;--> statement-breakpoint
ALTER TABLE `shelters` ADD `nudge_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `shelters` ADD `nudged_at` integer;