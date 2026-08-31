package com.leoyuan.leophoneagent.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.RoomDatabase.Callback
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        ChatSessionEntity::class,
        MessageEntity::class,
        CompactMarkerEntity::class,
        WebAppShortcutEntity::class,
        TreasureItemEntity::class,
        TreasureCollectionEntity::class,
        TreasureChunkEntity::class,
        TreasureHighlightEntity::class,
        TreasureJobEntity::class,
        TreasureChangeEntity::class,
    ],
    version = 12,
    exportSchema = false,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun chatDao(): ChatDao
    abstract fun webAppShortcutDao(): WebAppShortcutDao
    abstract fun treasureDao(): TreasureDao

    companion object {
        @Volatile
        private var INSTANCE: AppDatabase? = null

        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE sessions ADD COLUMN last_message TEXT")
                db.execSQL("ALTER TABLE sessions ADD COLUMN model_binding TEXT")
            }
        }

        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE messages ADD COLUMN reasoning_content TEXT")
            }
        }

        /**
         * compact_markers: add Phase-A id-first boundary columns. The legacy
         * sort_order columns stay for backfill; when both are present the
         * id-first fields win on lookup (see ChatDao.latestCompactMarker).
         */
        val MIGRATION_4_5 = object : Migration(4, 5) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE compact_markers ADD COLUMN first_kept_message_id TEXT")
                db.execSQL("ALTER TABLE compact_markers ADD COLUMN last_compacted_message_id TEXT")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_compact_markers_first_kept_message_id ON compact_markers(first_kept_message_id)")
            }
        }

        /**
         * T239: per-session thinking-mode override. Nullable so existing
         * sessions transparently keep "unset" semantics; only sessions where
         * the user explicitly chooses a level start storing a non-null value.
         */
        val MIGRATION_5_6 = object : Migration(5, 6) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE sessions ADD COLUMN thinking_override TEXT")
            }
        }

        /**
         * T-pwa-1: pwa_shortcuts table backs the home-screen PWA pinning
         * flow. Pure additive migration — no existing entity is modified
         * and no data is rewritten.
         *
         * Superseded by MIGRATION_8_9 below (Pwa → WebApp rename); kept
         * here so users who already migrated from <=6 land on a
         * consistent state before the rename runs.
         */
        val MIGRATION_6_7 = object : Migration(6, 7) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS pwa_shortcuts (
                        id TEXT NOT NULL PRIMARY KEY,
                        html_path TEXT NOT NULL,
                        path_scope TEXT NOT NULL,
                        scope_context TEXT,
                        title TEXT NOT NULL,
                        icon_ref TEXT NOT NULL,
                        icon_cache_path TEXT,
                        created_at INTEGER NOT NULL,
                        source_session_id TEXT
                    )
                    """.trimIndent()
                )
            }
        }

        /**
         * compact_markers: add `version` column for marker schema versioning.
         * Mirrors iOS Phase v2 — version=1 = legacy multi-field model,
         * version=2 = simplified id-only anchor model. Existing rows default
         * to 1 so legacy resolution code keeps running for them.
         */
        val MIGRATION_7_8 = object : Migration(7, 8) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE compact_markers ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
            }
        }

        /**
         * Pwa → WebApp rename: copy every row from `pwa_shortcuts` into a
         * new `webapp_shortcuts` table with identical schema, then drop
         * the old table. Row contents (UUIDs, html paths, icon refs) are
         * preserved verbatim — only the table name changes — so existing
         * in-app shortcut lists keep showing the same entries.
         *
         * Note: pinned launcher icons created before this rename still
         * carry the old `ACTION_OPEN_PWA` intent action and will be dead
         * after the upgrade (manifest no longer registers it). The user
         * has to re-pin from inside the app. Per
         * `feedback_no_destructive_git` we do NOT silently delete data —
         * the DB row stays, only the launcher-side icon dies.
         */
        val MIGRATION_8_9 = object : Migration(8, 9) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS webapp_shortcuts (
                        id TEXT NOT NULL PRIMARY KEY,
                        html_path TEXT NOT NULL,
                        path_scope TEXT NOT NULL,
                        scope_context TEXT,
                        title TEXT NOT NULL,
                        icon_ref TEXT NOT NULL,
                        icon_cache_path TEXT,
                        created_at INTEGER NOT NULL,
                        source_session_id TEXT
                    )
                    """.trimIndent()
                )
                db.execSQL(
                    """
                    INSERT INTO webapp_shortcuts (
                        id, html_path, path_scope, scope_context, title,
                        icon_ref, icon_cache_path, created_at, source_session_id
                    )
                    SELECT
                        id, html_path, path_scope, scope_context, title,
                        icon_ref, icon_cache_path, created_at, source_session_id
                    FROM pwa_shortcuts
                    """.trimIndent()
                )
                db.execSQL("DROP TABLE IF EXISTS pwa_shortcuts")
            }
        }

        /**
         * [T-error-persist-android] messages.error_info — persist the terminal
         * error sticker on an assistant turn so the inline error survives a
         * session reload (mirrors iOS messages.error_info). Pure additive,
         * nullable column; existing rows read back NULL (= no error). No data
         * rewrite.
         */
        val MIGRATION_9_10 = object : Migration(9, 10) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE messages ADD COLUMN error_info TEXT")
            }
        }

        val MIGRATION_10_11 = object : Migration(10, 11) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS treasure_items (
                        row_id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                        stable_id TEXT NOT NULL,
                        schema_version INTEGER NOT NULL,
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
                        byte_count INTEGER NOT NULL,
                        content_digest TEXT,
                        summary TEXT,
                        annotation TEXT,
                        tags_json TEXT NOT NULL,
                        collection_ids_json TEXT NOT NULL,
                        pinned INTEGER NOT NULL,
                        archived INTEGER NOT NULL,
                        reading_state TEXT NOT NULL,
                        reading_progress REAL NOT NULL,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL,
                        last_opened_at INTEGER,
                        processing_state TEXT NOT NULL,
                        processing_error_code TEXT,
                        sync_state TEXT NOT NULL,
                        origin_device_id TEXT NOT NULL,
                        deleted_at INTEGER
                    )
                """.trimIndent())
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_treasure_items_stable_id ON treasure_items(stable_id)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_treasure_items_deleted_at_updated_at ON treasure_items(deleted_at, updated_at)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_treasure_items_normalized_url_key ON treasure_items(normalized_url_key)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_treasure_items_content_digest ON treasure_items(content_digest)")
                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS treasure_collections (
                        id TEXT NOT NULL PRIMARY KEY,
                        name TEXT NOT NULL,
                        icon TEXT,
                        color_token TEXT,
                        sort_order INTEGER NOT NULL,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL,
                        deleted_at INTEGER
                    )
                """.trimIndent())
                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS treasure_chunks (
                        item_id TEXT NOT NULL,
                        chunk_index INTEGER NOT NULL,
                        section_label TEXT,
                        text TEXT NOT NULL,
                        start_offset INTEGER NOT NULL,
                        end_offset INTEGER NOT NULL,
                        PRIMARY KEY(item_id, chunk_index),
                        FOREIGN KEY(item_id) REFERENCES treasure_items(stable_id) ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                """.trimIndent())
                db.execSQL("CREATE INDEX IF NOT EXISTS index_treasure_chunks_item_id ON treasure_chunks(item_id)")
                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS treasure_jobs (
                        id TEXT NOT NULL PRIMARY KEY,
                        item_id TEXT NOT NULL,
                        job_type TEXT NOT NULL,
                        state TEXT NOT NULL,
                        attempt_count INTEGER NOT NULL,
                        next_attempt_at INTEGER,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL,
                        last_error_code TEXT,
                        FOREIGN KEY(item_id) REFERENCES treasure_items(stable_id) ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                """.trimIndent())
                db.execSQL("CREATE INDEX IF NOT EXISTS index_treasure_jobs_item_id ON treasure_jobs(item_id)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_treasure_jobs_state_next_attempt_at_created_at ON treasure_jobs(state, next_attempt_at, created_at)")
                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS treasure_changes (
                        sequence INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                        change_id TEXT NOT NULL,
                        item_id TEXT NOT NULL,
                        operation TEXT NOT NULL,
                        updated_at INTEGER NOT NULL,
                        origin_device_id TEXT NOT NULL,
                        payload_digest TEXT NOT NULL
                    )
                """.trimIndent())
                db.execSQL("CREATE INDEX IF NOT EXISTS index_treasure_changes_item_id ON treasure_changes(item_id)")
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_treasure_changes_change_id ON treasure_changes(change_id)")
                createTreasureAuxiliarySchema(db)
            }
        }

        val MIGRATION_11_12 = object : Migration(11, 12) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS treasure_highlights (
                        id TEXT NOT NULL PRIMARY KEY,
                        item_id TEXT NOT NULL,
                        quote_text TEXT NOT NULL,
                        note TEXT,
                        start_offset INTEGER NOT NULL,
                        end_offset INTEGER NOT NULL,
                        page_number INTEGER,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL,
                        origin_device_id TEXT NOT NULL,
                        deleted_at INTEGER,
                        FOREIGN KEY(item_id) REFERENCES treasure_items(stable_id) ON UPDATE NO ACTION ON DELETE CASCADE
                    )
                """.trimIndent())
                db.execSQL("CREATE INDEX IF NOT EXISTS index_treasure_highlights_item_id ON treasure_highlights(item_id)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_treasure_highlights_item_id_updated_at ON treasure_highlights(item_id, updated_at)")
            }
        }

        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                // sessions: add iOS-parity columns
                db.execSQL("ALTER TABLE sessions ADD COLUMN source TEXT")
                db.execSQL("ALTER TABLE sessions ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1")
                db.execSQL("ALTER TABLE sessions ADD COLUMN pinned_at INTEGER")
                db.execSQL("ALTER TABLE sessions ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0")

                // messages: add iOS-parity columns
                db.execSQL("ALTER TABLE messages ADD COLUMN stream_interrupt_count INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE messages ADD COLUMN updated_at INTEGER")

                // compact_markers: new table mirroring iOS
                db.execSQL("""
                    CREATE TABLE IF NOT EXISTS compact_markers (
                        id TEXT NOT NULL PRIMARY KEY,
                        session_id TEXT NOT NULL,
                        summary TEXT NOT NULL,
                        first_kept_sort_order INTEGER NOT NULL,
                        compacted_count INTEGER NOT NULL,
                        created_at INTEGER NOT NULL,
                        ui_boundary_sort_order INTEGER,
                        boundary_message_id TEXT,
                        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
                    )
                """.trimIndent())
                db.execSQL("CREATE INDEX IF NOT EXISTS index_compact_markers_session_id ON compact_markers(session_id)")
            }
        }

        fun getInstance(context: Context): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "minis.db"
                )
                    .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5, MIGRATION_5_6, MIGRATION_6_7, MIGRATION_7_8, MIGRATION_8_9, MIGRATION_9_10, MIGRATION_10_11, MIGRATION_11_12)
                    .addCallback(object : Callback() {
                        override fun onCreate(db: SupportSQLiteDatabase) {
                            super.onCreate(db)
                            createTreasureAuxiliarySchema(db)
                        }
                    })
                    .build()
                    .also { INSTANCE = it }
            }
        }

        internal fun createTreasureAuxiliarySchema(db: SupportSQLiteDatabase) {
            db.execSQL("""
                CREATE VIRTUAL TABLE IF NOT EXISTS treasure_search_fts USING fts4(
                    stable_id, title, original_text, summary, annotation, tags_json,
                    notindexed=stable_id, tokenize=unicode61
                )
            """.trimIndent())
            db.execSQL("""
                CREATE TRIGGER IF NOT EXISTS treasure_items_search_insert AFTER INSERT ON treasure_items
                WHEN new.deleted_at IS NULL BEGIN
                    INSERT INTO treasure_search_fts(rowid,stable_id,title,original_text,summary,annotation,tags_json)
                    VALUES(new.row_id,new.stable_id,COALESCE(new.title,''),COALESCE(new.original_text,''),COALESCE(new.summary,''),COALESCE(new.annotation,''),new.tags_json);
                END
            """.trimIndent())
            db.execSQL("""
                CREATE TRIGGER IF NOT EXISTS treasure_items_search_update AFTER UPDATE ON treasure_items BEGIN
                    DELETE FROM treasure_search_fts WHERE rowid=old.row_id;
                    INSERT INTO treasure_search_fts(rowid,stable_id,title,original_text,summary,annotation,tags_json)
                    SELECT new.row_id,new.stable_id,COALESCE(new.title,''),COALESCE(new.original_text,''),COALESCE(new.summary,''),COALESCE(new.annotation,''),new.tags_json
                    WHERE new.deleted_at IS NULL;
                END
            """.trimIndent())
            db.execSQL("""
                CREATE TRIGGER IF NOT EXISTS treasure_items_search_delete AFTER DELETE ON treasure_items BEGIN
                    DELETE FROM treasure_search_fts WHERE rowid=old.row_id;
                END
            """.trimIndent())
        }
    }
}
