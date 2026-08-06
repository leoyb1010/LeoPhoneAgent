-- IF NOT EXISTS 守护: 解决 main 合并 (commit 03df2cb) 前在 0008_vengeful_dragon_lord
-- 上已经创建过 schedules / schedule_runs 表的本地 DB. 合并后 scheduler 表迁移
-- 改名到 0010, drizzle 会重跑此迁移撞上 "table already exists". 全量重写为幂等
-- 让老 dev 机直接跳过, 新装机器行为不变.
CREATE TABLE IF NOT EXISTS `schedule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`schedule_id` text NOT NULL,
	`session_id` text,
	`fired_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`error_msg` text,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_schedule_runs_schedule` ON `schedule_runs` (`schedule_id`,`fired_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prompt` text NOT NULL,
	`kind` text DEFAULT 'cron' NOT NULL,
	`cron_expr` text NOT NULL,
	`timezone` text NOT NULL,
	`recurring` integer DEFAULT true NOT NULL,
	`agent_kind` text NOT NULL,
	`model` text,
	`effort` text,
	`working_dir` text,
	`use_worktree` integer DEFAULT false NOT NULL,
	`target_session_id` text,
	`notify_desktop` integer DEFAULT true NOT NULL,
	`notify_feishu` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_fired_at` integer,
	`next_fire_at` integer,
	`expire_at` integer,
	FOREIGN KEY (`target_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_schedules_active_next` ON `schedules` (`status`,`next_fire_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_schedules_target_session` ON `schedules` (`target_session_id`);
