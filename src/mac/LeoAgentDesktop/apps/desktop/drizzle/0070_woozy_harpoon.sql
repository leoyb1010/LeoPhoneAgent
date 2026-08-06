-- 幂等守卫:重放安全(参考 0036)
CREATE TABLE IF NOT EXISTS `media_blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`ext` text NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`is_cache` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_access_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `media_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`ref_kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`origin_session_id` text,
	`origin_kind` text,
	`origin_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`hash`) REFERENCES `media_blobs`(`hash`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_refs_hash_idx` ON `media_refs` (`hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_refs_ref_idx` ON `media_refs` (`ref_kind`,`ref_id`);