DROP INDEX IF EXISTS `idx_sessions_working_dir`;--> statement-breakpoint
CREATE INDEX `idx_sessions_workdir_created` ON `sessions` (`working_dir`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_created_at` ON `sessions` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_created_at` ON `messages` (`created_at`,`id`);