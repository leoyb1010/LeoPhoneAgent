CREATE TABLE `account_usage_snapshots` (
	`agent_kind` text PRIMARY KEY NOT NULL,
	`snapshot` text NOT NULL,
	`updated_at` integer NOT NULL
);
