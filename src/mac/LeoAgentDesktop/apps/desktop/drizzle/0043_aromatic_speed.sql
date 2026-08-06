PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_im_bindings` (
	`channel` text NOT NULL,
	`bot_context_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scope_key` text DEFAULT '' NOT NULL,
	`target_session_id` text NOT NULL,
	`attached_at` integer NOT NULL,
	`attached_via_card_message_id` text,
	PRIMARY KEY(`channel`, `bot_context_id`, `user_id`, `scope_key`),
	FOREIGN KEY (`target_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- 注: 生成器在 SELECT 里引用了旧表不存在的新列 scope_key — 改为 '' 字面量
-- (存量行全是 feishu 单接管, scope 语义即 '';仅此一处手工修正, 结构语句未动)
INSERT INTO `__new_im_bindings`("channel", "bot_context_id", "user_id", "scope_key", "target_session_id", "attached_at", "attached_via_card_message_id") SELECT "channel", "bot_context_id", "user_id", '', "target_session_id", "attached_at", "attached_via_card_message_id" FROM `im_bindings`;--> statement-breakpoint
DROP TABLE `im_bindings`;--> statement-breakpoint
ALTER TABLE `__new_im_bindings` RENAME TO `im_bindings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_im_bindings_target` ON `im_bindings` (`target_session_id`);