CREATE TABLE `issue_triage_blacklist` (
	`issue_id` text NOT NULL,
	`schedule_id` text NOT NULL,
	`until_at` integer NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `schedule_id`),
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_issue_triage_blacklist_until_at` ON `issue_triage_blacklist` (`until_at`);--> statement-breakpoint
ALTER TABLE `schedules` ADD `job_type` text DEFAULT 'prompt' NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` ADD `job_config` text;