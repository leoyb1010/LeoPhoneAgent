CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_use_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_messages_session_client` ON `messages` (`session_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_session_created` ON `messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `migration_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT 'New CCS' NOT NULL,
	`working_dir` text,
	`model` text DEFAULT 'claude-sonnet-4-6' NOT NULL,
	`effort` text DEFAULT 'high' NOT NULL,
	`permission_mode` text DEFAULT 'ask' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`sdk_session_id` text,
	`total_token_usage` integer DEFAULT 0 NOT NULL,
	`total_cost_usd` real DEFAULT 0 NOT NULL,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`context_window` integer DEFAULT 0 NOT NULL,
	`fast_mode` integer DEFAULT false NOT NULL,
	`cleared_at` integer,
	`pinned_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_updated_at` ON `sessions` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_sessions_sdk_session_id` ON `sessions` (`sdk_session_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_working_dir` ON `sessions` (`working_dir`);--> statement-breakpoint
INSERT INTO `migration_meta` (`key`, `value`) VALUES
  ('schema_version', '0'),
  ('cloud_migration_status', 'pending'),
  ('cloud_migration_synced', '0');