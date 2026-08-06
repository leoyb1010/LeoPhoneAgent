ALTER TABLE `sessions` ADD `user_send_at` integer;--> statement-breakpoint
CREATE INDEX `idx_sessions_user_send_at` ON `sessions` (`user_send_at`);--> statement-breakpoint
UPDATE `sessions` SET `user_send_at` = (
  SELECT MAX(`messages`.`created_at`)
  FROM `messages`
  WHERE `messages`.`session_id` = `sessions`.`id`
    AND `messages`.`role` = 'user'
);
