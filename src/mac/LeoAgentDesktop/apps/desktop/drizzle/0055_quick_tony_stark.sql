ALTER TABLE `session_goals` ADD `max_turns` integer;--> statement-breakpoint
ALTER TABLE `session_goals` ADD `no_progress_limit` integer;--> statement-breakpoint
ALTER TABLE `session_goals` ADD `no_progress_streak` integer DEFAULT 0 NOT NULL;