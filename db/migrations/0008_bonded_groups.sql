ALTER TABLE `animals` ADD `bonded_group_id` text;--> statement-breakpoint
CREATE INDEX `animals_bonded_group_idx` ON `animals` (`bonded_group_id`);