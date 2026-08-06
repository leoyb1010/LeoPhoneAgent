CREATE TABLE `im_bindings` (
	`channel` text NOT NULL,
	`bot_context_id` text NOT NULL,
	`user_id` text NOT NULL,
	`target_session_id` text NOT NULL,
	`attached_at` integer NOT NULL,
	`attached_via_card_message_id` text,
	PRIMARY KEY(`channel`, `bot_context_id`, `user_id`),
	FOREIGN KEY (`target_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_im_bindings_target` ON `im_bindings` (`target_session_id`);