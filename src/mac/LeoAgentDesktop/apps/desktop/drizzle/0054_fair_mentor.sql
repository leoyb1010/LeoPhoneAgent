PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_session_goals` (
	`session_id` text PRIMARY KEY NOT NULL,
	`objective` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`budget_tokens` integer,
	`turns_used` integer DEFAULT 0 NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`last_reason` text,
	`agent_kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_session_goals`("session_id", "objective", "status", "budget_tokens", "turns_used", "tokens_used", "last_reason", "agent_kind", "started_at", "updated_at") SELECT "session_id", "objective", "status", "budget_tokens", "turns_used", "tokens_used", "last_reason", "agent_kind", "started_at", "updated_at" FROM `session_goals`;--> statement-breakpoint
DROP TABLE `session_goals`;--> statement-breakpoint
ALTER TABLE `__new_session_goals` RENAME TO `session_goals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_session_goals_status` ON `session_goals` (`status`);