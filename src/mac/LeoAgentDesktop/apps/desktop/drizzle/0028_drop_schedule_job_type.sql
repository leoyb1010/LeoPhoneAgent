DELETE FROM schedules WHERE job_type = 'issue-triage';--> statement-breakpoint
ALTER TABLE schedules DROP COLUMN job_type;--> statement-breakpoint
ALTER TABLE schedules DROP COLUMN job_config;
