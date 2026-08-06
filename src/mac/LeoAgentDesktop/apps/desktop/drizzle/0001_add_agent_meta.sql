ALTER TABLE `messages` ADD `agent_meta` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `agent_kind` text DEFAULT 'cc' NOT NULL;