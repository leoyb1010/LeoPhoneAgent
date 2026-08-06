ALTER TABLE `messages` ADD `rewind_at` integer;--> statement-breakpoint
CREATE INDEX `idx_messages_rewind_at` ON `messages` (`rewind_at`);
