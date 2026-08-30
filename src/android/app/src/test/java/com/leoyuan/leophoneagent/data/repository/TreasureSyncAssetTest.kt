package com.leoyuan.leophoneagent.data.repository

import com.leoyuan.leophoneagent.data.db.TreasureDao
import com.leoyuan.leophoneagent.data.db.TreasureItemEntity
import com.leoyuan.leophoneagent.data.db.mergeRemoteTreasureItem
import com.leoyuan.leophoneagent.treasury.treasurySyncAvailability
import com.leoyuan.leophoneagent.treasury.validTreasuryContentRange
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
            val repository = TreasureRepository(dao(item = { current }), root) { "android-test" }

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

    @Test
    fun `remote body and attachment caches are verified and stored without local changes`() = runBlocking {
        val root = Files.createTempDirectory("treasury-remote-cache").toFile()
        try {
            var current = item(
                id = "remote-body", kind = "text", originDeviceId = "ios-phone",
                syncState = "remote_only",
            )
            val repository = TreasureRepository(
                dao({ current }) { current = it }, root,
            ) { "android-test" }
            val body = "跨端按需正文"
            val bodyDigest = sha256(body.toByteArray())
            val cachedBody = repository.cacheRemoteBody(
                current.id, body, bodyDigest, body.toByteArray().size.toLong(),
            )
            assertEquals(body, cachedBody?.originalText)
            assertEquals("remote_only", cachedBody?.syncState)

            current = item(
                id = "remote-file", kind = "document", mimeType = "application/pdf",
                byteCount = 0, originDeviceId = "ios-phone", syncState = "remote_only",
            )
            val partial = repository.remoteAssetPartialFile(current.id, "attachment")
            val bytes = "%PDF-range-resume".toByteArray()
            partial.writeBytes(bytes)
            val digest = sha256(bytes)
            val cachedFile = repository.cacheRemoteAttachment(
                current.id, partial, "application/pdf", bytes.size.toLong(), digest,
            )
            assertNotNull(cachedFile?.bodyRef)
            assertTrue(cachedFile!!.bodyRef!!.startsWith("remote-assets/"))
            assertEquals(digest, cachedFile.contentDigest)
            assertTrue(root.resolve(cachedFile.bodyRef!!).isFile)
            assertFalse(partial.exists())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `range response must match retained prefix and full byte count`() {
        assertTrue(validTreasuryContentRange("bytes 7-15/16", 7, 16))
        assertFalse(validTreasuryContentRange("bytes 6-15/16", 7, 16))
        assertFalse(validTreasuryContentRange("bytes 7-15/17", 7, 16))
        assertFalse(validTreasuryContentRange("bytes */16", 7, 16))
        assertFalse(validTreasuryContentRange("bytes 7-16/16", 7, 16))
    }

    @Test
    fun `new remote metadata invalidates old cache even when replacement is smaller`() {
        val existing = item(
            id = "remote-update", kind = "document", bodyRef = "remote-assets/old.bin",
            mimeType = "application/pdf", byteCount = 4_096,
            contentDigest = "a".repeat(64), originDeviceId = "ios-phone",
            syncState = "remote_only",
        )
        val incoming = existing.copy(
            bodyRef = null, mimeType = "image/png", byteCount = 512,
            contentDigest = "b".repeat(64), updatedAt = 2_000,
        )

        val merged = mergeRemoteTreasureItem(
            existing = existing, incoming = incoming,
            preserveLocalAssets = false, conflict = false,
        )

        assertNull(merged.bodyRef)
        assertEquals(512, merged.byteCount)
        assertEquals("b".repeat(64), merged.contentDigest)
        assertEquals("image/png", merged.mimeType)
    }

    @Test
    fun `resumable partial rejects and removes symbolic links`() {
        val root = Files.createTempDirectory("treasury-partial-link").toFile()
        try {
            val repository = TreasureRepository(dao(item = { item("remote", "document") }), root) {
                "android-test"
            }
            val outside = Files.createTempFile("treasury-outside", ".bin")
            Files.write(outside, byteArrayOf(1, 2, 3))
            val partial = repository.remoteAssetPartialFile("remote", "attachment")
            Files.createSymbolicLink(partial.toPath(), outside)

            assertEquals(0, repository.remoteAssetPartialLength(partial, 1024))
            assertFalse(Files.exists(partial.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS))
            Files.deleteIfExists(outside)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun `resumable cache rejects symbolic link directories`() {
        val root = Files.createTempDirectory("treasury-partial-root-link").toFile()
        val outside = Files.createTempDirectory("treasury-partial-root-outside").toFile()
        try {
            val repository = TreasureRepository(dao(item = { item("remote", "document") }), root) {
                "android-test"
            }
            Files.createSymbolicLink(root.resolve("sync-inbox").toPath(), outside.toPath())

            assertTrue(runCatching {
                repository.remoteAssetPartialFile("remote", "attachment")
            }.isFailure)
            assertEquals(0, outside.listFiles()?.size ?: 0)
        } finally {
            root.deleteRecursively()
            outside.deleteRecursively()
        }
    }

    private fun dao(
        item: () -> TreasureItemEntity,
        update: (TreasureItemEntity) -> Unit = {},
    ): TreasureDao = Proxy.newProxyInstance(
        TreasureDao::class.java.classLoader,
        arrayOf(TreasureDao::class.java),
    ) { _, method, args ->
        when (method.name) {
            "getById" -> item().takeIf { it.id == args?.firstOrNull() }
            "cacheRemoteBody" -> {
                val current = item()
                if (current.id != args?.get(0) || current.originDeviceId == args[1]) 0 else {
                    update(current.copy(originalText = args[2] as String))
                    1
                }
            }
            "cacheRemoteAttachment" -> {
                val current = item()
                if (current.id != args?.get(0) || current.originDeviceId == args[1]) 0 else {
                    update(current.copy(
                        bodyRef = args[2] as String,
                        mimeType = args[3] as String,
                        byteCount = args[4] as Long,
                        contentDigest = args[5] as String,
                    ))
                    1
                }
            }
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
        originDeviceId: String = "android-test",
        syncState: String = "pending",
    ) = TreasureItemEntity(
        id = id, kind = kind, sourceLabel = "测试", originalText = originalText,
        bodyRef = bodyRef, mimeType = mimeType, byteCount = byteCount,
        contentDigest = contentDigest, createdAt = 1_000, updatedAt = 1_000,
        processingState = "ready", syncState = syncState, originDeviceId = originDeviceId,
    )

    private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(bytes).joinToString("") { "%02x".format(it) }
}
