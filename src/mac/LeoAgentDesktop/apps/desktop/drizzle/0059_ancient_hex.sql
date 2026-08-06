CREATE TABLE `right_sidebar_tabs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`position` integer NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`state` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `right_sidebar_tabs_session_idx` ON `right_sidebar_tabs` (`session_id`,`position`);