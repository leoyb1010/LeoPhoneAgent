CREATE TABLE `daily_spend` (
	`day` text PRIMARY KEY NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
