package com.leoyuan.leophoneagent.data.repository

import com.leoyuan.leophoneagent.data.db.TreasureDao
import com.leoyuan.leophoneagent.data.db.TreasureItemEntity
import com.leoyuan.leophoneagent.treasury.treasurySyncAvailability
import java.lang.reflect.Proxy
import java.nio.file.Files
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TreasureSyncAssetTest {
    @Test
    fun `artifact file is advertised as attachment and not as text body`() {
        val fileArtifact = TreasureItemRecord(
            id = "artifact", kind = "artifact", sourceLabel = "聊天产出",
            bodyRef = "files/report.pdf", mimeType = "application/pdf",
            originDeviceId = "android-test",
        )
        assertEquals(false, treasurySyncAvailability(fileArtifact).body)
        assertEquals(true, treasurySyncAvailability(fileArtifact).attachment)

        val textualArtifact = fileArtifact.copy(originalText = "可引用的文字摘要")
        assertEquals(true, treasurySyncAvailability(textualArtifact).body)
        assertEquals(true, treasurySyncAvailability(textualArtifact).attachment)
    }

    @Test
    fun `on-demand body and attachment stay inside managed storage and verify digest`() = runBlocking {
        val root = Files.createTempDirectory("treasury-sync-asset").toFile()
        try {
            val attachment = root.resolve("files/document.pdf").apply {
                requireNotNull(parentFile).mkdirs()
                writeText("verified attachment")
            }
            var current = item(
                id = "attachment", kind = "document", bodyRef = "files/document.pdf",
                byteCount = attachment.length(), contentDigest = sha256(attachment.readBytes()),
                mimeType = "application/pdf",
            )
            val repository = TreasureRepository(dao { current }, root) { "android-test" }

            val asset = repository.syncAsset("attachment", "attachment")
            assertNotNull(asset)
            assertEquals(attachment.canonicalFile, asset!!.file)
            assertEquals(attachment.length(), asset.byteCount)
            assertEquals(sha256(attachment.readBytes()), asset.digest)
            assertFalse(asset.removeAfterUpload)

            current = current.copy(contentDigest = "0".repeat(64))
            assertNull(repository.syncAsset("attachment", "attachment"))
            current = current.copy(bodyRef = "../private.pdf", contentDigest = null)
            assertNull(repository.syncAsset("attachment", "attachment"))

            current = item(id = "body", kind = "text", originalText = "按需正文")
            val body = repository.syncAsset("body", "body")
            assertNotNull(body)
            assertEquals("按需正文", body!!.file.readText())
            assertTrue(body.removeAfterUpload)
            assertEquals(sha256("按需正文".toByteArray()), body.digest)
            body.file.delete()

            current = current.copy(originalText = null, originDeviceId = "remote-device")
            assertNull(repository.syncAsset("body", "body"))
        } finally {
            root.deleteRecursively()
        }
    }

    private fun dao(item: () -> TreasureItemEntity): TreasureDao = Proxy.newProxyInstance(
        TreasureDao::class.java.classLoader,
        arrayOf(TreasureDao::class.java),
    ) { _, method, args ->
        when (method.name) {
            "getById" -> item().takeIf { it.id == args?.firstOrNull() }
            "toString" -> "TreasureSyncAssetTestDao"
            "hashCode" -> 1
            "equals" -> false
            else -> error("Unexpected DAO call: ${method.name}")
        }
    } as TreasureDao

    private fun item(
        id: String,
        kind: String,
        originalText: String? = null,
        bodyRef: String? = null,
        mimeType: String? = null,
        byteCount: Long = 0,
        contentDigest: String? = null,
    ) = TreasureItemEntity(
        id = id, kind = kind, sourceLabel = "测试", originalText = originalText,
        bodyRef = bodyRef, mimeType = mimeType, byteCount = byteCount,
        contentDigest = contentDigest, createdAt = 1_000, updatedAt = 1_000,
        processingState = "ready", syncState = "pending", originDeviceId = "android-test",
    )

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it) }
}
