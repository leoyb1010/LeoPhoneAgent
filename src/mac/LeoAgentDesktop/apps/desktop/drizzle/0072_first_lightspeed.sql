-- 意识聊天卡片(卡槽③海报模式,C3d'):一行 = 一次 ghost_call 的最新卡片版本。
-- IF NOT EXISTS 为幂等补写(规则 17 允许的生成后修饰,参考 0070),回放测试要求 59+ 可重放。
CREATE TABLE IF NOT EXISTS `ghost_cards` (
	`call_id` text PRIMARY KEY NOT NULL,
	`ghost_id` text NOT NULL,
	`session_id` text,
	`html` text NOT NULL,
	`height` integer NOT NULL,
	`v` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ghost_cards_updated_at_idx` ON `ghost_cards` (`updated_at`);
