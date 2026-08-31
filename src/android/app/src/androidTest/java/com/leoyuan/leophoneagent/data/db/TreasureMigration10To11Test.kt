package com.leoyuan.leophoneagent.data.db

import android.content.Context
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TreasureMigration10To11Test {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val name = "treasure-migration-${System.nanoTime()}.db"

    @After
    fun cleanUp() {
        context.deleteDatabase(name)
    }

    @Test
    fun migrationCreatesItemsJobsChangesAndSearchTriggers() {
        val helper = FrameworkSQLiteOpenHelperFactory().create(
            SupportSQLiteOpenHelper.Configuration.builder(context)
                .name(name)
                .callback(object : SupportSQLiteOpenHelper.Callback(10) {
                    override fun onCreate(db: SupportSQLiteDatabase) = Unit
                    override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
                })
                .build()
        )
        val db = helper.writableDatabase
        AppDatabase.MIGRATION_10_11.migrate(db)

        assertTrue(tableExists(db, "treasure_items"))
        assertTrue(tableExists(db, "treasure_jobs"))
        assertTrue(tableExists(db, "treasure_changes"))
        assertTrue(tableExists(db, "treasure_search_fts"))
        db.execSQL(
            """
            INSERT INTO treasure_items(
              stable_id,schema_version,kind,title,source_label,byte_count,tags_json,
              collection_ids_json,pinned,archived,reading_state,reading_progress,
              created_at,updated_at,processing_state,sync_state,origin_device_id
            ) VALUES('fixture',1,'text','fixture title','文本',0,'[]','[]',0,0,'none',0,1,1,'saved','local','test')
            """.trimIndent()
        )
        db.query("SELECT COUNT(*) FROM treasure_search_fts WHERE treasure_search_fts MATCH 'fixture'").use {
            assertTrue(it.moveToFirst())
            assertEquals(1, it.getInt(0))
        }
        helper.close()
    }

    private fun tableExists(db: SupportSQLiteDatabase, table: String): Boolean =
        db.query("SELECT 1 FROM sqlite_master WHERE name=?", arrayOf(table)).use { it.moveToFirst() }
}
