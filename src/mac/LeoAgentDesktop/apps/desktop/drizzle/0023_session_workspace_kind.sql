ALTER TABLE `sessions` ADD `workspace_kind` text DEFAULT 'project' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_sessions_workspace_kind` ON `sessions` (`workspace_kind`);