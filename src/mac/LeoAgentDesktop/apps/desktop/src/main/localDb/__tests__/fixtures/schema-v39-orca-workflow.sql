CREATE TABLE migration_meta (
  key text PRIMARY KEY NOT NULL,
  value text
);

INSERT INTO migration_meta (key, value) VALUES ('schema_version', '39');

CREATE TABLE migration_history (
  seq integer PRIMARY KEY NOT NULL,
  file_name text NOT NULL,
  content_hash text NOT NULL,
  applied_at integer NOT NULL
);

CREATE TABLE schedules (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  prompt text NOT NULL,
  job_type text DEFAULT 'prompt' NOT NULL,
  job_config text,
  source text DEFAULT 'user',
  project_config_id text,
  kind text DEFAULT 'cron' NOT NULL,
  cron_expr text NOT NULL,
  timezone text NOT NULL,
  recurring integer DEFAULT true NOT NULL,
  manual integer DEFAULT false NOT NULL,
  interval_ms integer,
  agent_kind text NOT NULL,
  model text,
  effort text,
  working_dir text,
  workspace_kind text DEFAULT 'project' NOT NULL,
  use_worktree integer DEFAULT false NOT NULL,
  target_session_id text,
  persistent_session integer DEFAULT false NOT NULL,
  notify_desktop integer DEFAULT true NOT NULL,
  notify_feishu integer DEFAULT false NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  last_fired_at integer,
  last_finished_at integer,
  next_fire_at integer,
  expire_at integer
);

-- schedule_runs 的 v39 形态(0010 建表 + 0012 read_at + 0016 result_text)—
-- 0062(heartbeat_at 心跳租约列)开始有后续迁移 ALTER 本表, fixture 必须带上。
CREATE TABLE schedule_runs (
  id text PRIMARY KEY NOT NULL,
  schedule_id text NOT NULL,
  session_id text,
  fired_at integer NOT NULL,
  finished_at integer,
  status text NOT NULL,
  error_msg text,
  read_at integer,
  result_text text
);

-- sessions 的 v39 形态最小切片 — 0042(slack: im_bot_context_id / im_user_id
-- 列 + idx_sessions_im_lookup 索引)开始有后续迁移 ALTER 本表, fixture 必须
-- 带上该表才能回放。列集只保留替换索引/未来 ALTER 会引用到的部分。
CREATE TABLE sessions (
  id text PRIMARY KEY NOT NULL,
  title text NOT NULL,
  working_dir text,
  model text NOT NULL,
  effort text NOT NULL,
  permission_mode text NOT NULL,
  fast_mode integer DEFAULT false NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  agent_kind text DEFAULT 'cc' NOT NULL,
  source text DEFAULT 'desktop' NOT NULL,
  feishu_open_id text,
  feishu_bot_app_id text,
  sdk_session_id text,
  user_send_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);

CREATE TABLE orca_workflows (
  id text PRIMARY KEY NOT NULL,
  lead_session_id text NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  completed_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);

CREATE UNIQUE INDEX uniq_orca_workflows_active_lead_session_id
ON orca_workflows (lead_session_id)
WHERE "orca_workflows"."status" = 'active';

CREATE INDEX idx_orca_workflows_status ON orca_workflows (status);

CREATE TABLE orca_workers (
  id text PRIMARY KEY NOT NULL,
  workflow_id text NOT NULL,
  session_id text NOT NULL,
  status text DEFAULT 'idle' NOT NULL,
  label text,
  worktree_branch text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);

CREATE UNIQUE INDEX uniq_orca_workers_session_id ON orca_workers (session_id);
CREATE INDEX idx_orca_workers_workflow_id ON orca_workers (workflow_id);
CREATE INDEX idx_orca_workers_status ON orca_workers (status);

INSERT INTO orca_workflows
  (id, lead_session_id, status, completed_at, created_at, updated_at)
VALUES
  ('team-1', 'lead-session-1', 'active', NULL, 1000, 1000);

INSERT INTO orca_workers
  (id, workflow_id, session_id, status, label, worktree_branch, created_at, updated_at)
VALUES
  ('worker-1', 'team-1', 'worker-session-1', 'idle', 'alpha', NULL, 1100, 1100),
  ('worker-2', 'team-1', 'worker-session-2', 'idle', 'beta', NULL, 1200, 1200);

-- 0043 起有迁移重建 im_bindings — 补上 v39 时点的表切片(0008 创建的旧形态,
-- 无 scope_key 列), 含一行数据验证存量行经表重建迁移后 scope_key 落 ''
CREATE TABLE im_bindings (
  channel text NOT NULL,
  bot_context_id text NOT NULL,
  user_id text NOT NULL,
  target_session_id text NOT NULL,
  attached_at integer NOT NULL,
  attached_via_card_message_id text,
  PRIMARY KEY(channel, bot_context_id, user_id),
  FOREIGN KEY (target_session_id) REFERENCES sessions(id) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX idx_im_bindings_target ON im_bindings (target_session_id);
INSERT INTO sessions (id, title, working_dir, model, effort, permission_mode, source, created_at, updated_at)
VALUES ('im-session-1', 'feishu chat', '/tmp/wd', 'claude-opus-4-7', 'xhigh', 'auto', 'feishu', 900, 900);
INSERT INTO im_bindings
  (channel, bot_context_id, user_id, target_session_id, attached_at, attached_via_card_message_id)
VALUES
  ('feishu', 'cli_test', 'ou_test', 'im-session-1', 1000, NULL);
