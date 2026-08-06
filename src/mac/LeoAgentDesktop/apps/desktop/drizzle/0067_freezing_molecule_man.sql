-- 幂等守卫:重放安全(参考 0036;replay 测试会以 currentVersion 回退方式二次重放)
CREATE TABLE IF NOT EXISTS `agent_input_queue_snapshots` (
	`session_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
