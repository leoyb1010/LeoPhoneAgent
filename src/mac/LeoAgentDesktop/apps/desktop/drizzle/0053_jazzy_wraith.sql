CREATE TABLE `session_goals` (
	`session_id` text PRIMARY KEY NOT NULL,
	`objective` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`budget_tokens` integer NOT NULL,
	`max_turns` integer NOT NULL,
	`turns_used` integer DEFAULT 0 NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`no_progress_streak` integer DEFAULT 0 NOT NULL,
	`last_reason` text,
	`agent_kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_session_goals_status` ON `session_goals` (`status`);