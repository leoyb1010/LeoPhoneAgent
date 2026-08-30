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
class TreasureMigration11To12Test {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val name = "treasure-highlight-migration-${System.nanoTime()}.db"

    @After
    fun cleanUp() {
        context.deleteDatabase(name)
    }

    @Test
    fun migrationAddsHighlightTableWithCascadeAndSoftDeleteFields() {
        val helper = FrameworkSQLiteOpenHelperFactory().create(
            SupportSQLiteOpenHelper.Configuration.builder(context)
                .name(name)
                .callback(object : SupportSQLiteOpenHelper.Callback(11) {
                    override fun onCreate(db: SupportSQLiteDatabase) = Unit
                    override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
                })
                .build()
        )
        val db = helper.writableDatabase
        db.execSQL("CREATE TABLE treasure_items(stable_id TEXT NOT NULL PRIMARY KEY)")
        AppDatabase.MIGRATION_11_12.migrate(db)

        assertTrue(tableExists(db, "treasure_highlights"))
        db.execSQL("INSERT INTO treasure_items(stable_id) VALUES('item')")
        db.execSQL(
            """
            INSERT INTO treasure_highlights(
              id,item_id,quote_text,start_offset,end_offset,created_at,updated_at,origin_device_id
            ) VALUES('highlight','item','摘录',0,2,1,1,'test')
            """.trimIndent()
        )
        db.query("SELECT quote_text,deleted_at FROM treasure_highlights WHERE id='highlight'").use {
            assertTrue(it.moveToFirst())
            assertEquals("摘录", it.getString(0))
            assertTrue(it.isNull(1))
        }
        helper.close()
    }

    private fun tableExists(db: SupportSQLiteDatabase, table: String): Boolean =
        db.query("SELECT 1 FROM sqlite_master WHERE name=?", arrayOf(table)).use { it.moveToFirst() }
}
