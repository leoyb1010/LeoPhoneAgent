-- 0022_curvy_luckman: Orca multi-agent workflow tables + sessions.orca_role.
-- 用 `IF NOT EXISTS` 让本迁移在表/索引侧幂等 —— 极端情况下(迁移半途崩溃后重试、
-- 或 dev branch 早期合入版本残留的部分状态)再跑一次不会因为对象已存在而炸事务。
-- ALTER TABLE ADD COLUMN 在 SQLite 没有 IF NOT EXISTS 语义;只影响 dev 端
-- 曾经手动跑过 mr-21 早期 0021_curvy_luckman 的同事,他们走 `pnpm db:reset` 即可。
CREATE TABLE IF NOT EXISTS `orca_workers` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`session_id` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`label` text,
	`worktree_branch` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `orca_workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uniq_orca_workers_session_id` ON `orca_workers` (`session_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_orca_workers_workflow_id` ON `orca_workers` (`workflow_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_orca_workers_status` ON `orca_workers` (`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `orca_workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`lead_session_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`lead_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uniq_orca_workflows_lead_session_id` ON `orca_workflows` (`lead_session_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_orca_workflows_status` ON `orca_workflows` (`status`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `orca_role` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_orca_role` ON `sessions` (`orca_role`);
