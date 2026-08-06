CREATE TABLE `project_automation_consents` (
	`working_dir` text PRIMARY KEY NOT NULL,
	`consented_at` integer NOT NULL,
	`config_hash` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `schedules` ADD `source` text DEFAULT 'user';--> statement-breakpoint
ALTER TABLE `schedules` ADD `project_config_id` text;