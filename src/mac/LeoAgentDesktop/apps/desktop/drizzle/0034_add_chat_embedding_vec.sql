CREATE TABLE `embedding_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
-- ── chat embedding (Phase 1.2): vec0 虚表 + rewind trigger + 元信息登记 ─────
-- 虚表 / trigger 不在 drizzle-kit 自动生成范围 (drizzle-orm 不支持 virtual table),
-- 手写追加, snapshot.json 中只跟踪 embedding_meta — 设计上 vec 表所有访问均走
-- raw SQL, 不经过 drizzle ORM, 这是有意的 (见 schema.ts vecTableMeta 注释)。
--
-- 命名带 _v1 后缀: 将来如果模型 / dim / 切片策略变了, 直接新建 _v2 表 + 在
-- vec_table_meta 中并存登记, 灰度切换。
--> statement-breakpoint
CREATE VIRTUAL TABLE `chat_messages_vec_v1` USING vec0(
	embedding FLOAT[1024]
);
--> statement-breakpoint
-- rewind 一致性: 用户 rewind 一条 message 时 (rewind_at IS NULL → NOT NULL),
-- 同步清掉 vec 表里对应的向量行 + embedding_jobs 队列里残留的同 source_id 行;
-- 避免被 rewind 的消息继续出现在语义搜索结果里。vec rowid 与 embedding_jobs.rowid
-- 是一一对应的 (commitEmbeddings 用 BigInt(job.rowid) 写入 vec 行)。
--> statement-breakpoint
CREATE TRIGGER `trg_chat_rewind_clean_vec`
AFTER UPDATE OF `rewind_at` ON `messages`
WHEN NEW.rewind_at IS NOT NULL AND OLD.rewind_at IS NULL
BEGIN
	DELETE FROM `chat_messages_vec_v1` WHERE rowid IN (
		SELECT rowid FROM `embedding_jobs` WHERE source = 'chat' AND source_id = NEW.id
	);
	DELETE FROM `embedding_jobs` WHERE source = 'chat' AND source_id = NEW.id;
END;
--> statement-breakpoint
-- vec_table_meta 登记: chat-history-embedder.setupChatHistoryEmbedder 启动时
-- 也会通过 EmbeddingService.registerVecTable 调一次 INSERT OR IGNORE (幂等),
-- 这里 migration 顺手写一份, 避免老用户首次升级 vec_table_meta 是空的。
--> statement-breakpoint
INSERT OR IGNORE INTO `vec_table_meta` (`vec_table`, `source`, `model_id`, `dim`, `registered_at`, `notes`)
VALUES ('chat_messages_vec_v1', 'chat', 'voyage/voyage-4', 1024, (CAST(strftime('%s', 'now') AS INTEGER) * 1000), 'chat 消息默认 embedding 表 (1024d voyage-4)');
