ALTER TABLE `sessions` ADD `im_bot_context_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `im_user_id` text;--> statement-breakpoint
CREATE INDEX `idx_sessions_im_lookup` ON `sessions` (`source`,`im_bot_context_id`,`im_user_id`);