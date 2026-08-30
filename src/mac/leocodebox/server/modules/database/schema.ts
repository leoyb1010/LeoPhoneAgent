const USER_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME,
    is_active BOOLEAN DEFAULT 1,
    git_name TEXT,
    git_email TEXT,
    has_completed_onboarding BOOLEAN DEFAULT 0
);
`;

export const API_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key_name TEXT NOT NULL,
    api_key TEXT UNIQUE NOT NULL,
    key_prefix TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_used DATETIME,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_CREDENTIALS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    credential_name TEXT NOT NULL,
    credential_type TEXT NOT NULL, -- 'github_token', 'gitlab_token', 'bitbucket_token', etc.
    credential_value TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_notification_preferences (
    user_id INTEGER PRIMARY KEY,
    preferences_json TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const VAPID_KEYS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vapid_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_key TEXT NOT NULL,
    private_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    keys_p256dh TEXT NOT NULL,
    keys_auth TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notification_channel_endpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    endpoint_id TEXT NOT NULL,
    label TEXT,
    metadata_json TEXT,
    enabled BOOLEAN DEFAULT 1,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, channel, endpoint_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const PROJECTS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL UNIQUE,
    custom_project_name TEXT DEFAULT NULL,
    isStarred BOOLEAN DEFAULT 0,
    isArchived BOOLEAN DEFAULT 0
);
`;

export const SESSIONS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'claude',
    -- The session id used by the provider CLI/SDK on disk (JSONL file name,
    -- store.db folder, sqlite row id, ...). \`session_id\` is the stable
    -- app-facing id that the frontend uses for the whole session lifetime;
    -- \`provider_session_id\` is filled in once the provider announces its own
    -- id mid-run, or equals \`session_id\` for sessions discovered on disk.
    provider_session_id TEXT,
    custom_name TEXT,
    project_path TEXT,
    jsonl_path TEXT,
    isArchived BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id),
    FOREIGN KEY (project_path) REFERENCES projects(project_path)
    ON DELETE SET NULL
    ON UPDATE CASCADE
);
`;

export const LAST_SCANNED_AT_SQL = `
CREATE TABLE IF NOT EXISTS scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_scanned_at TIMESTAMP NULL
);
`;

export const APP_CONFIG_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// Agent profiles (智能体档案): named launch presets — provider/model/effort/
// permission + opening prompt — stored as a JSON blob per row so the shape can
// evolve without migrations (the repo normalizes on read).
export const AGENT_PROFILES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_profiles (
    profile_id TEXT PRIMARY KEY NOT NULL,
    user_id INTEGER NOT NULL,
    profile_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;


export const USAGE_DAILY_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_daily (
    day TEXT NOT NULL,
    project_path TEXT,
    provider TEXT NOT NULL,
    model TEXT,
    session_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (day, project_path, provider, model)
);
`;


export const SESSION_RUNTIME_STATE_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS session_runtime_state (
    session_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    provider TEXT NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    aborted BOOLEAN DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
`;

export const MISSION_CARDS_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mission_cards (
    card_id TEXT PRIMARY KEY NOT NULL,
    user_id INTEGER NOT NULL,
    project_path TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    profile_id TEXT,
    slot TEXT,
    provider TEXT NOT NULL DEFAULT 'claude',
    worktree_id TEXT,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'backlog',
    cost_usd REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

export const TREASURE_TABLES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS treasure_items (
    id TEXT PRIMARY KEY NOT NULL,
    user_id INTEGER NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    kind TEXT NOT NULL,
    title TEXT,
    source_uri TEXT,
    normalized_url_key TEXT,
    source_app TEXT,
    source_label TEXT NOT NULL,
    original_text TEXT,
    body_ref TEXT,
    preview_ref TEXT,
    mime_type TEXT,
    byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count >= 0),
    content_digest TEXT,
    summary TEXT,
    annotation TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    collection_ids_json TEXT NOT NULL DEFAULT '[]',
    pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    reading_state TEXT NOT NULL DEFAULT 'none',
    reading_progress REAL NOT NULL DEFAULT 0 CHECK(reading_progress BETWEEN 0 AND 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_opened_at TEXT,
    processing_state TEXT NOT NULL DEFAULT 'saved',
    processing_error_code TEXT,
    sync_state TEXT NOT NULL DEFAULT 'local',
    origin_device_id TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_treasure_items_user_updated
    ON treasure_items(user_id, deleted_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_treasure_items_url
    ON treasure_items(user_id, normalized_url_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_treasure_items_digest
    ON treasure_items(user_id, content_digest) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS treasure_collections (
    id TEXT PRIMARY KEY NOT NULL,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    color_token TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS treasure_chunks (
    item_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    section_label TEXT,
    text TEXT NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    PRIMARY KEY(item_id, chunk_index),
    FOREIGN KEY (item_id) REFERENCES treasure_items(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS treasure_highlights (
    id TEXT PRIMARY KEY NOT NULL,
    item_id TEXT NOT NULL,
    quote_text TEXT NOT NULL,
    note TEXT,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    page_number INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    origin_device_id TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (item_id) REFERENCES treasure_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_treasure_highlights_item
    ON treasure_highlights(item_id, deleted_at, updated_at);

CREATE TABLE IF NOT EXISTS treasure_jobs (
    id TEXT PRIMARY KEY NOT NULL,
    item_id TEXT NOT NULL,
    job_type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_error_code TEXT,
    FOREIGN KEY (item_id) REFERENCES treasure_items(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_treasure_jobs_ready
    ON treasure_jobs(state, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS treasure_changes (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    change_id TEXT UNIQUE NOT NULL,
    item_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    origin_device_id TEXT NOT NULL,
    payload_digest TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_treasure_changes_item ON treasure_changes(item_id, sequence);

CREATE VIRTUAL TABLE IF NOT EXISTS treasure_search_fts USING fts5(
    item_id UNINDEXED, user_id UNINDEXED, title, original_text, summary, annotation, tags,
    tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS treasure_search_insert AFTER INSERT ON treasure_items
WHEN new.deleted_at IS NULL BEGIN
    INSERT INTO treasure_search_fts(rowid,item_id,user_id,title,original_text,summary,annotation,tags)
    VALUES(new.rowid,new.id,new.user_id,COALESCE(new.title,''),COALESCE(new.original_text,''),
           COALESCE(new.summary,''),COALESCE(new.annotation,''),new.tags_json);
END;
CREATE TRIGGER IF NOT EXISTS treasure_search_update AFTER UPDATE ON treasure_items BEGIN
    DELETE FROM treasure_search_fts WHERE rowid=old.rowid;
    INSERT INTO treasure_search_fts(rowid,item_id,user_id,title,original_text,summary,annotation,tags)
    SELECT new.rowid,new.id,new.user_id,COALESCE(new.title,''),COALESCE(new.original_text,''),
           COALESCE(new.summary,''),COALESCE(new.annotation,''),new.tags_json
    WHERE new.deleted_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS treasure_search_delete AFTER DELETE ON treasure_items BEGIN
    DELETE FROM treasure_search_fts WHERE rowid=old.rowid;
END;

-- Mac FTS triggers index synchronously, so an index job is already complete.
-- This also repairs queued index rows created by earlier Treasury builds.
UPDATE treasure_jobs SET state='completed', next_attempt_at=NULL,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), last_error_code=NULL
WHERE job_type='index' AND state IN ('queued','failed','processing');
`;

export const WORKTREES_TABLE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS worktrees (
    worktree_id TEXT PRIMARY KEY NOT NULL,
    project_path TEXT NOT NULL,
    slug TEXT NOT NULL,
    branch TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

export const INIT_SCHEMA_SQL = `
-- Initialize authentication database
PRAGMA foreign_keys = ON;

${USER_TABLE_SCHEMA_SQL}
-- Indexes for performance for user lookups
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

${API_KEYS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(api_key);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active);

${USER_CREDENTIALS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_credentials_user_id ON user_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_user_credentials_type ON user_credentials(credential_type);
CREATE INDEX IF NOT EXISTS idx_user_credentials_active ON user_credentials(is_active);

${USER_NOTIFICATION_PREFERENCES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id);

${VAPID_KEYS_TABLE_SCHEMA_SQL}

${PUSH_SUBSCRIPTIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

${NOTIFICATION_CHANNEL_ENDPOINTS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_user_channel ON notification_channel_endpoints(user_id, channel);
CREATE INDEX IF NOT EXISTS idx_notification_channel_endpoints_enabled ON notification_channel_endpoints(enabled);

${PROJECTS_TABLE_SCHEMA_SQL}
-- NOTE: These indexes are created in migrations after legacy table-shape repairs.
-- Creating them here can fail on upgraded installs where projects lacks those columns.

${SESSIONS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_session_ids_lookup ON sessions(session_id);
-- NOTE: This index is created in migrations after sessions is rebuilt to include project_path.
-- Creating it here can fail on upgraded installs where the legacy sessions table has no project_path.

${LAST_SCANNED_AT_SQL}

${APP_CONFIG_TABLE_SCHEMA_SQL}

${AGENT_PROFILES_TABLE_SCHEMA_SQL}

${USAGE_DAILY_TABLE_SCHEMA_SQL}

${SESSION_RUNTIME_STATE_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_agent_profiles_user_id ON agent_profiles(user_id);

${WORKTREES_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_path);

${MISSION_CARDS_TABLE_SCHEMA_SQL}
CREATE INDEX IF NOT EXISTS idx_mission_cards_user ON mission_cards(user_id);
CREATE INDEX IF NOT EXISTS idx_mission_cards_project ON mission_cards(project_path);

${TREASURE_TABLES_SCHEMA_SQL}
`;
