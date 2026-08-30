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
import kotlinx.coroutines.flow.first
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
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

    @Test
    fun compactSearchReturnsFtsSnippetWithoutLoadingTheFullBody() = runBlocking {
        val database = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        try {
            val repository = TreasureRepository(
                dao = database.treasureDao(),
                filesDirectory = context.cacheDir,
                originDeviceId = { "android-test" },
            )
            repository.save(TreasureItemRecord(
                id = "search-projection",
                kind = "text",
                sourceLabel = "文本",
                originalText = "前文".repeat(1_000) + " uniqueprojectionhit " + "后文".repeat(1_000),
                originDeviceId = "android-test",
            ))

            val result = repository.search("uniqueprojectionhit").first().single()
            assertTrue(result.snippet.contains("uniqueprojectionhit"))
            assertTrue(result.matchOffsets.isNotBlank())
            assertFalse(result::class.java.declaredFields.any { it.name == "originalText" })
        } finally {
            database.close()
        }
    }

    @Test
    fun staleProcessingJobMarksItsItemFailedAndLeavesAChangeForSync() = runBlocking {
        val database = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        try {
            val repository = TreasureRepository(
                dao = database.treasureDao(),
                filesDirectory = context.cacheDir,
                originDeviceId = { "android-test" },
            )
            repository.save(TreasureItemRecord(
                id = "interrupted-item",
                kind = "link",
                sourceUri = "https://example.com/interrupted",
                sourceLabel = "example.com",
                processingState = "queued",
                originDeviceId = "android-test",
            ))
            val job = repository.readyJobs().first { it.jobType == "metadata" }
            assertTrue(repository.claimJob(job.id, now = 1))
            database.openHelper.writableDatabase.execSQL(
                "UPDATE treasure_jobs SET updated_at = 1 WHERE id = ?",
                arrayOf(job.id),
            )
            val before = repository.changes(0).size

            assertEquals(1, repository.recoverInterruptedJobs(staleBefore = 2, now = 3))
            assertEquals("failed", repository.get(listOf("interrupted-item")).single().processingState)
            assertEquals(before + 1, repository.changes(0).size)
        } finally {
            database.close()
        }
    }

    @Test
    fun backgroundEnhancementDoesNotOverwriteATitleEditedAfterTheJobWasCaptured() = runBlocking {
        val database = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        try {
            val repository = TreasureRepository(
                dao = database.treasureDao(), filesDirectory = context.cacheDir,
                originDeviceId = { "android-test" },
            )
            repository.save(TreasureItemRecord(
                id = "title-race", kind = "link", title = "分享时标题",
                sourceUri = "https://example.com/title-race", sourceLabel = "example.com",
                processingState = "queued", originDeviceId = "android-test",
            ))
            repository.updateItem("title-race", title = "用户手写标题")

            repository.applyEnhancement(
                "title-race", title = "网页抓取标题", capturedTitle = "分享时标题",
                originalText = "网页正文", state = "ready",
            )

            val updated = repository.get(listOf("title-race")).single()
            assertEquals("用户手写标题", updated.title)
            assertEquals("网页正文", updated.originalText)
        } finally {
            database.close()
        }
    }

    @Test
    fun explicitRetryResetsTheJobAndMovesTheVisibleItemBackToQueued() = runBlocking {
        val database = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        try {
            val repository = TreasureRepository(
                dao = database.treasureDao(), filesDirectory = context.cacheDir,
                originDeviceId = { "android-test" },
            )
            repository.save(TreasureItemRecord(
                id = "retry-visible", kind = "link", sourceUri = "https://example.com/retry",
                sourceLabel = "example.com", processingState = "queued", originDeviceId = "android-test",
            ))
            val job = repository.readyJobs().first { it.itemId == "retry-visible" }
            assertTrue(repository.claimJob(job.id))
            assertTrue(repository.failJob(job.id, "network_unavailable"))
            assertTrue(repository.markProcessingFailed("retry-visible", "network_unavailable"))

            assertEquals(1, repository.retryFailedJobs("retry-visible"))
            val item = repository.get(listOf("retry-visible")).single()
            assertEquals("queued", item.processingState)
            assertEquals(null, item.processingErrorCode)
            assertEquals(0, repository.readyJobs().first { it.id == job.id }.attemptCount)
        } finally {
            database.close()
        }
    }

    @Test
    fun exactFiltersReadingProgressAndHighlightsRoundTrip() = runBlocking {
        val database = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        try {
            val repository = TreasureRepository(
                dao = database.treasureDao(),
                filesDirectory = context.cacheDir,
                originDeviceId = { "android-test" },
            )
            repository.save(TreasureItemRecord(
                id = "reading-item", kind = "text", sourceLabel = "文本",
                originalText = "第一段需要高亮。第二段继续阅读。", tags = listOf("资料"),
                readingState = "unread", processingState = "ready",
                originDeviceId = "android-test",
            ))

            assertEquals(1, repository.search("type:text read:unread tag:资料").first().size)
            repository.updateItem("reading-item", tags = listOf("A\"B"))
            assertEquals(1, repository.search("tag:a\"b").first().size)
            val opened = repository.markOpened("reading-item")!!
            assertEquals("reading", opened.readingState)
            assertTrue(opened.lastOpenedAt != null)
            assertEquals("read", repository.updateReadingProgress("reading-item", 1.0)!!.readingState)
            val reset = repository.updateItem("reading-item", readingState = "unread")!!
            assertEquals("unread", reset.readingState)
            assertEquals(0.0, reset.readingProgress, 0.0)

            val highlight = repository.addHighlight("reading-item", 0, 7, "第一段需要高亮")
            assertEquals(1, repository.observeHighlights("reading-item").first().size)
            assertTrue(repository.deleteHighlight(highlight.id))
            assertTrue(repository.observeHighlights("reading-item").first().isEmpty())
        } finally {
            database.close()
        }
    }

    @Test
    fun pdfPageExtractionStoresPageChunksIndexesTextAndKeepsHighlights() = runBlocking {
        val database = Room.inMemoryDatabaseBuilder(context, AppDatabase::class.java).build()
        try {
            val repository = TreasureRepository(
                dao = database.treasureDao(), filesDirectory = context.cacheDir,
                originDeviceId = { "android-test" },
            )
            repository.save(TreasureItemRecord(
                id = "pdf-item", kind = "document", sourceLabel = "PDF",
                originalText = "用户已经高亮", processingState = "processing",
                originDeviceId = "android-test",
            ))
            val highlight = repository.addHighlight("pdf-item", 0, 6, "用户已经高亮")

            assertTrue(repository.applyDocumentExtraction(
                "pdf-item", listOf("第一页正文", "第二页关键字 Fold8", ""),
            ))

            assertTrue(repository.search("Fold8").first().single().snippet.contains("Fold8"))
            val cursor = database.openHelper.readableDatabase.query(
                "SELECT section_label,text FROM treasure_chunks WHERE item_id=? ORDER BY chunk_index",
                arrayOf("pdf-item"),
            )
            cursor.use {
                assertEquals(2, it.count)
                assertTrue(it.moveToFirst())
                assertEquals("page:1", it.getString(0))
                assertTrue(it.moveToNext())
                assertEquals("第二页关键字 Fold8", it.getString(1))
            }
            assertEquals(highlight.id, repository.observeHighlights("pdf-item").first().single().id)
        } finally {
            database.close()
        }
    }
}
