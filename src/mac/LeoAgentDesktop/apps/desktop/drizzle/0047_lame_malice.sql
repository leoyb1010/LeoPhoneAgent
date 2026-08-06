CREATE TABLE `project_aliases` (
	`project_key` text PRIMARY KEY NOT NULL,
	`alias` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_project_aliases_updated_at` ON `project_aliases` (`updated_at`);