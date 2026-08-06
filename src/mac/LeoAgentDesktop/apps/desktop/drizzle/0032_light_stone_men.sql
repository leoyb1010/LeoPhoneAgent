CREATE TABLE `embedding_jobs` (
	`rowid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`chunk_index` integer DEFAULT 0 NOT NULL,
	`model_id` text NOT NULL,
	`vec_table` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending','running','done','failed')),
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`scheduled_at` integer NOT NULL,
	`locked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_embedding_jobs_natural` ON `embedding_jobs` (`source`,`source_id`,`chunk_index`,`model_id`);--> statement-breakpoint
CREATE INDEX `idx_embedding_jobs_status_scheduled` ON `embedding_jobs` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_embedding_jobs_source_id` ON `embedding_jobs` (`source`,`source_id`);--> statement-breakpoint
CREATE TABLE `vec_table_meta` (
	`vec_table` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`model_id` text NOT NULL,
	`dim` integer NOT NULL,
	`registered_at` integer NOT NULL,
	`notes` text
);
