CREATE TABLE `migration_history` (
	`seq` integer PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`content_hash` text NOT NULL,
	`applied_at` integer NOT NULL
);
