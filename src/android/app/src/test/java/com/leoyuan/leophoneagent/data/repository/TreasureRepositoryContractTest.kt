package com.leoyuan.leophoneagent.data.repository

import java.time.Instant
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TreasureRepositoryContractTest {
    @Test
    fun normalizedUrlRemovesTrackingFragmentAndSortsQuery() {
        assertEquals(
            "https://example.com/read?a=1&b=2",
            TreasureRepository.normalizedUrlKey(
                "https://EXAMPLE.com:443/read?b=2&utm_source=share&a=1#section"
            )
        )
        assertNull(TreasureRepository.normalizedUrlKey("file:///data/local.txt"))
        assertNull(TreasureRepository.normalizedUrlKey("https://token@example.com/private"))
    }

    @Test
    fun localReferencesRejectTraversalAndAbsolutePaths() {
        assertTrue(TreasureRepository.isSafeRelativeRef("notes/item.md"))
        assertTrue(TreasureRepository.isSafeRelativeRef(null))
        assertFalse(TreasureRepository.isSafeRelativeRef("../secret"))
        assertFalse(TreasureRepository.isSafeRelativeRef("/data/secret"))
        assertFalse(TreasureRepository.isSafeRelativeRef("notes//item.md"))
        assertFalse(TreasureRepository.isSafeRelativeRef("notes\\..\\secret"))
        assertFalse(TreasureRepository.isSafeRelativeRef("C:\\private\\secret"))
        assertFalse(TreasureRepository.isSafeRelativeRef("notes/item\u0000.md"))
    }

    @Test
    fun tagsAreTrimmedAndCaseInsensitiveDeduplicated() {
        assertEquals(
            listOf("Android", "离线"),
            TreasureRepository.normalizedTags(listOf(" Android ", "android", "离线", " "))
        )
    }

    @Test
    fun ftsExpressionBoundsAndEscapesUntrustedQuery() {
        val expression = TreasureRepository.ftsExpression("Room \"quoted\" Fold")
        assertEquals("\"Room\"* AND \"\"\"quoted\"\"\"* AND \"Fold\"*", expression)
        assertTrue(TreasureRepository.ftsExpression("x".repeat(2_000)).length <= 515)
    }

    @Test
    fun sharedContractRoundTripsSnakeCaseFields() {
        val now = Instant.parse("2026-08-30T00:00:00Z").toString()
        val record = TreasureItemRecord(
            id = "shared-fixture", kind = "document", title = "迁移样本",
            sourceLabel = "PDF", bodyRef = "bodies/shared.md", byteCount = 42,
            tags = listOf("离线"), readingState = "reading", readingProgress = 0.5,
            createdAt = now, updatedAt = now, processingState = "ready",
            syncState = "pending", originDeviceId = "android-test",
        )
        val json = Json { encodeDefaults = true }
        val payload = json.encodeToString(record)
        val decoded = json.decodeFromString<TreasureItemRecord>(payload)

        assertEquals(record, decoded)
        assertTrue(payload.contains("\"schema_version\""))
        assertTrue(payload.contains("\"origin_device_id\""))
        assertFalse(payload.contains("schemaVersion"))
    }

    @Test
    fun repositorySharedFixtureDecodesAndReencodes() {
        val payload = requireNotNull(javaClass.classLoader?.getResourceAsStream(
            "treasure_item_v1.fixture.json"
        )).bufferedReader().use { it.readText() }
        val json = Json { encodeDefaults = true }
        val decoded = json.decodeFromString<TreasureItemRecord>(payload)
        val roundTrip = json.decodeFromString<TreasureItemRecord>(json.encodeToString(decoded))

        assertEquals(decoded, roundTrip)
        assertEquals("shared-contract-fixture", decoded.id)
        assertEquals("document", decoded.kind)
        assertEquals(0.5, decoded.readingProgress, 0.0)
    }

    @Test
    fun markdownImportPreservesLinksTextAndTags() {
        val records = TreasureRepository.parseMarkdown(
            """
            ## 文档入口

            Source: https://example.com/docs?utm_source=share

            Tags: #离线 #Android

            ---

            ## 迁移备注

            Room 与 SQLite 正文

            Tags: #迁移
            """.trimIndent(),
            deviceId = "android-test",
        )

        assertEquals(2, records.size)
        assertEquals("link", records[0].kind)
        assertEquals("https://example.com/docs?utm_source=share", records[0].sourceUri)
        assertEquals(listOf("离线", "Android"), records[0].tags)
        assertEquals("text", records[1].kind)
        assertEquals("Room 与 SQLite 正文", records[1].originalText)
        assertEquals(listOf("迁移"), records[1].tags)
    }
}
