ALTER TABLE `sessions` ADD `parent_session_id` text REFERENCES `sessions`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `forked_at_message_id` text;--> statement-breakpoint
CREATE INDEX `idx_sessions_parent_session_id` ON `sessions` (`parent_session_id`);
