CREATE TABLE `recent_workdirs` (
	`path` text PRIMARY KEY NOT NULL,
	`last_used_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_recent_workdirs_last_used_at` ON `recent_workdirs` (`last_used_at`);