ALTER TABLE `sessions` ADD `worktree_path` text;--> statement-breakpoint
CREATE INDEX `idx_sessions_worktree_path` ON `sessions` (`worktree_path`);