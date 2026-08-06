ALTER TABLE `schedules` ADD `job_type` text DEFAULT 'prompt' NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` ADD `job_config` text;