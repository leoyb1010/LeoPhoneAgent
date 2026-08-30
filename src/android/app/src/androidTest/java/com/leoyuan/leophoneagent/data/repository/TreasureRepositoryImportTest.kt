package com.leoyuan.leophoneagent.data.repository

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.leoyuan.leophoneagent.data.db.AppDatabase
import java.time.Instant
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TreasureRepositoryImportTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun jsonImportPersistsValidRowsAndIsolatesDuplicatesAndBadRows() = runBlocking {
        val database = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java)
            .allowMainThreadQueries()
            .build()
        try {
            val repository = TreasureRepository(
                dao = database.treasureDao(),
                filesDirectory = context.cacheDir,
                originDeviceId = { "android-test" },
            )
            val now = Instant.parse("2026-08-30T00:00:00Z").toString()
            val valid = TreasureItemRecord(
                id = "import-valid", kind = "link", title = "导入链接",
                sourceUri = "https://example.com/docs?utm_source=share",
                sourceLabel = "example.com", createdAt = now, updatedAt = now,
                originDeviceId = "android-test",
            )
            val duplicate = valid.copy(
                id = "import-duplicate", sourceUri = "https://example.com/docs",
            )
            val invalid = valid.copy(id = "import-invalid", kind = "executable")
            val report = repository.importJsonAndSave(
                Json.encodeToString(listOf(valid, duplicate, invalid))
            )

            assertEquals(TreasureImportReport(1, 1, 1), report)
            assertEquals(1, database.treasureDao().getByIds(listOf(valid.id, duplicate.id)).size)
            assertEquals(2, repository.readyJobs().size)
            assertEquals(1, repository.changes(after = 0).size)
        } finally {
            database.close()
        }
    }

    @Test
    fun concurrentCaptureDeduplicatesInsideRoomTransaction() = runBlocking {
        val database = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        try {
            val repository = TreasureRepository(
                dao = database.treasureDao(),
                filesDirectory = context.cacheDir,
                originDeviceId = { "android-test" },
            )
            val now = Instant.parse("2026-08-30T00:00:00Z").toString()
            val ids = (0..<20).map { "concurrent-$it" }
            coroutineScope {
                ids.map { id ->
                    async {
                        repository.save(TreasureItemRecord(
                            id = id, kind = "link", sourceLabel = "example.com",
                            sourceUri = "https://example.com/concurrent?utm_source=$id",
                            createdAt = now, updatedAt = now,
                            originDeviceId = "android-test",
                        ))
                    }
                }.awaitAll()
            }

            assertEquals(1, database.treasureDao().getByIds(ids).size)
            assertEquals(1, repository.changes(after = 0).size)
        } finally {
            database.close()
        }
    }
}
