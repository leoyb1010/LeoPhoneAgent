CREATE TABLE `skill_usage_exposures` (
	`id` text PRIMARY KEY NOT NULL,
	`analyzer_version` text DEFAULT '6' NOT NULL,
	`raw_file_path` text NOT NULL,
	`raw_line_no` integer NOT NULL,
	`session_id` text NOT NULL,
	`sdk_session_id` text NOT NULL,
	`agent_kind` text NOT NULL,
	`skill_name` text NOT NULL,
	`skill_path` text,
	`skill_document_hash` text,
	`exposure_content_hash` text NOT NULL,
	`document_hash_source` text NOT NULL,
	`source` text NOT NULL,
	`tool_use_id` text,
	`seen_at` integer NOT NULL,
	`tool_call_count` integer DEFAULT 0 NOT NULL,
	`repeated_tool_call_count` integer DEFAULT 0 NOT NULL,
	`tool_error_count` integer DEFAULT 0 NOT NULL,
	`command_call_count` integer DEFAULT 0 NOT NULL,
	`command_failure_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`raw_file_path`) REFERENCES `skill_usage_sources`(`raw_file_path`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_skill_usage_exposures_skill_document_version` ON `skill_usage_exposures` (`analyzer_version`,`skill_name`,`skill_document_hash`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_exposures_session` ON `skill_usage_exposures` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_exposures_raw_file` ON `skill_usage_exposures` (`raw_file_path`);--> statement-breakpoint
CREATE TABLE `skill_usage_sources` (
	`raw_file_path` text PRIMARY KEY NOT NULL,
	`analyzer_version` text DEFAULT '6' NOT NULL,
	`agent_kind` text NOT NULL,
	`session_id` text NOT NULL,
	`sdk_session_id` text NOT NULL,
	`mtime_ms` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`last_scanned_at` integer NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_skill_usage_sources_session` ON `skill_usage_sources` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_sources_sdk_session` ON `skill_usage_sources` (`sdk_session_id`);