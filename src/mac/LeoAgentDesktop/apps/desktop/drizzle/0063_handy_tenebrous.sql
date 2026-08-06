-- device-link 同机多实例单持有者仲裁凭据表(单行,id 恒为 1):谁持有谁连 relay。
-- IF NOT EXISTS:多 worktree 共用同一用户 DB 的 dev 环境 / 回放测试里表可能已由
-- HEAD schema 建出,幂等建表跳过即可(同 0010 / 0022 先例)。
CREATE TABLE IF NOT EXISTS `device_link_ownership` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`owner_pid` integer NOT NULL,
	`owner_label` text,
	`heartbeat_at` integer NOT NULL
);
