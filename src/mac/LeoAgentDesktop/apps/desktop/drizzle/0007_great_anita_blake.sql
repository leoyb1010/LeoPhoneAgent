ALTER TABLE `sessions` ADD `source` text DEFAULT 'desktop' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `feishu_open_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `feishu_bot_app_id` text;--> statement-breakpoint
CREATE INDEX `idx_sessions_feishu_lookup` ON `sessions` (`source`,`feishu_bot_app_id`,`feishu_open_id`);