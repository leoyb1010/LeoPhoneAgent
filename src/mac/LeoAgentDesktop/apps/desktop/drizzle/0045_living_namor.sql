CREATE TABLE `session_pr_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`url` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_session_pr_refs` ON `session_pr_refs` (`session_id`,`owner`,`repo`,`pr_number`);--> statement-breakpoint
CREATE INDEX `idx_session_pr_refs_session_last_seen` ON `session_pr_refs` (`session_id`,`last_seen_at`);