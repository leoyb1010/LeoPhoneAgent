package com.leoyuan.leophoneagent.treasury

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import com.leoyuan.leophoneagent.MinisApp
import com.leoyuan.leophoneagent.data.repository.TreasureItemRecord
import com.leoyuan.leophoneagent.share.PendingShare
import com.leoyuan.leophoneagent.share.SharedShareStore
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.util.Locale
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

data class TreasuryCaptureResult(
    val savedCount: Int,
    val duplicateCount: Int,
    val failedCount: Int,
    val itemIds: List<String>,
)

/**
 * The only Android ingress for Treasury content. Raw bytes are copied into the
 * app-owned Treasury directory before any parsing or network work starts.
 */
object TreasuryCaptureService {
    private const val MAX_TEXT_CHARS = 2_000_000
    private const val MAX_FILE_BYTES = 100L * 1024L * 1024L
    private const val MAX_TOTAL_BYTES = 200L * 1024L * 1024L

    suspend fun capturePendingShare(context: Context, share: PendingShare): TreasuryCaptureResult =
        withContext(Dispatchers.IO) {
            val app = context.applicationContext as MinisApp
            val repository = app.treasureRepository
            val deviceId = com.leoyuan.leophoneagent.data.DeviceIdentity.deviceId(context)
            var saved = 0
            var duplicates = 0
            var failed = 0
            val ids = mutableListOf<String>()

            for (input in share.items) {
                var prepared: Prepared? = null
                var committed = false
                try {
                    val value = when (input.kind) {
                        PendingShare.Item.Kind.INLINE_TEXT -> prepareText(input, deviceId)
                        PendingShare.Item.Kind.ATTACHMENT -> prepareAttachment(context, input, deviceId)
                    }
                    prepared = value
                    val stored = withContext(NonCancellable) { repository.save(value.record) }
                    committed = true
                    ids += stored.id
                    if (stored.id == value.record.id) {
                        saved += 1
                    } else {
                        duplicates += 1
                        value.copiedFile?.delete()
                    }
                    currentCoroutineContext().ensureActive()
                } catch (error: CancellationException) {
                    if (!committed) prepared?.copiedFile?.delete()
                    throw error
                } catch (_: Throwable) {
                    if (!committed) prepared?.copiedFile?.delete()
                    failed += 1
                }
            }

            if (saved > 0) TreasuryWorkScheduler.enqueue(context)
            TreasuryCaptureResult(saved, duplicates, failed, ids.distinct())
        }

    suspend fun captureTextOrUrl(context: Context, content: String, title: String? = null): TreasuryCaptureResult {
        val share = PendingShare(
            items = listOf(PendingShare.Item(
                kind = PendingShare.Item.Kind.INLINE_TEXT,
                value = content,
                mimeType = "text/plain",
                displayName = title,
            )),
            timestampMs = System.currentTimeMillis(),
        )
        return capturePendingShare(context, share)
    }

    suspend fun captureUris(context: Context, uris: List<Uri>): TreasuryCaptureResult = withContext(Dispatchers.IO) {
        val staged = mutableListOf<PendingShare.Item>()
        val directory = SharedShareStore.sharedFileDirectory(context)
        var totalBytes = 0L
        try {
            for (uri in uris.take(20)) {
                val displayName = context.contentResolver.query(
                    uri,
                    arrayOf(OpenableColumns.DISPLAY_NAME),
                    null,
                    null,
                    null,
                )?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0)?.take(240) else null }
                val mime = context.contentResolver.getType(uri) ?: "application/octet-stream"
                val extension = safeExtension(displayName ?: "file", mime)
                val name = "picked-${UUID.randomUUID()}${extension?.let { ".$it" }.orEmpty()}"
                val target = File(directory, name)
                val remainingBatchBytes = MAX_TOTAL_BYTES - totalBytes
                require(remainingBatchBytes > 0) { "Capture batch exceeds limit" }
                val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
                    TreasuryFilePolicy.copyToFileLimited(
                        input = input,
                        target = target,
                        maxBytes = minOf(MAX_FILE_BYTES, remainingBatchBytes),
                    )
                } ?: throw IllegalArgumentException("Unreadable document")
                totalBytes += bytes
                staged += PendingShare.Item(PendingShare.Item.Kind.ATTACHMENT, name, mime, displayName)
            }
            capturePendingShare(context, PendingShare(staged, System.currentTimeMillis()))
        } finally {
            SharedShareStore.cleanSharedFiles(context, staged)
        }
    }

    private data class Prepared(val record: TreasureItemRecord, val copiedFile: File? = null)

    private fun prepareText(input: PendingShare.Item, deviceId: String): Prepared {
        val text = input.value.trim().take(MAX_TEXT_CHARS)
        require(text.isNotEmpty()) { "Empty shared text" }
        val normalizedUrl = com.leoyuan.leophoneagent.data.repository.TreasureRepository.normalizedUrlKey(text)
        val now = Instant.now().toString()
        return if (normalizedUrl != null) {
            val host = runCatching { java.net.URI(text).host }.getOrNull() ?: "网页"
            Prepared(TreasureItemRecord(
                kind = "link",
                title = input.displayName?.trim()?.takeIf(String::isNotEmpty)?.take(500),
                sourceUri = text,
                sourceApp = "android.share",
                sourceLabel = host,
                readingState = "unread",
                processingState = "queued",
                syncState = "pending",
                originDeviceId = deviceId,
                createdAt = now,
                updatedAt = now,
            ))
        } else {
            Prepared(TreasureItemRecord(
                kind = "text",
                title = input.displayName?.trim()?.takeIf(String::isNotEmpty)?.take(500),
                sourceApp = "android.share",
                sourceLabel = "文本",
                originalText = text,
                processingState = "queued",
                syncState = "pending",
                originDeviceId = deviceId,
                createdAt = now,
                updatedAt = now,
            ))
        }
    }

    private fun prepareAttachment(context: Context, input: PendingShare.Item, deviceId: String): Prepared {
        require(input.value == File(input.value).name) { "Unsafe staged filename" }
        val source = File(SharedShareStore.sharedFileDirectory(context), input.value).canonicalFile
        val stagingRoot = SharedShareStore.sharedFileDirectory(context).canonicalFile
        require(source.parentFile == stagingRoot && source.isFile) { "Missing staged attachment" }

        val extension = safeExtension(input.displayName ?: input.value, input.mimeType)
        val id = UUID.randomUUID().toString()
        val relativeRef = "files/$id${extension?.let { ".$it" }.orEmpty()}"
        val root = File(context.filesDir, "treasury").apply { mkdirs() }
        val files = File(root, "files").apply { mkdirs() }
        val destination = File(root, relativeRef)
        require(destination.parentFile?.canonicalFile == files.canonicalFile) { "Unsafe Treasury destination" }
        val temporary = File(files, ".$id.importing")
        val digest = MessageDigest.getInstance("SHA-256")
        var byteCount = 0L
        try {
            source.inputStream().buffered().use { incoming ->
                temporary.outputStream().buffered().use { outgoing ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        val count = incoming.read(buffer)
                        if (count < 0) break
                        byteCount += count
                        require(byteCount <= MAX_FILE_BYTES) { "File exceeds capture limit" }
                        digest.update(buffer, 0, count)
                        outgoing.write(buffer, 0, count)
                    }
                }
            }
            check(temporary.renameTo(destination)) { "Unable to commit Treasury attachment" }
        } catch (error: Throwable) {
            temporary.delete()
            destination.delete()
            throw error
        }

        val mime = input.mimeType?.substringBefore(';')?.takeIf(String::isNotBlank)
            ?: extension?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
            ?: "application/octet-stream"
        val kind = when {
            mime.startsWith("image/") -> "image"
            mime.startsWith("audio/") -> "audio"
            mime.startsWith("video/") -> "video"
            else -> "document"
        }
        val now = Instant.now().toString()
        return Prepared(
            record = TreasureItemRecord(
                id = id,
                kind = kind,
                title = input.displayName?.trim()?.takeIf(String::isNotEmpty)?.take(500)
                    ?: source.name,
                sourceApp = "android.share",
                sourceLabel = when (kind) {
                    "image" -> "图片"
                    "audio" -> "音频"
                    "video" -> "视频"
                    else -> "文件"
                },
                bodyRef = relativeRef,
                mimeType = mime,
                byteCount = byteCount,
                contentDigest = digest.digest().joinToString("") { "%02x".format(it) },
                processingState = "queued",
                syncState = "pending",
                originDeviceId = deviceId,
                createdAt = now,
                updatedAt = now,
            ),
            copiedFile = destination,
        )
    }

    private fun safeExtension(displayName: String, mimeType: String?): String? {
        val fromName = displayName.substringAfterLast('.', "").lowercase(Locale.ROOT)
            .takeIf { it.matches(Regex("[a-z0-9]{1,10}")) }
        if (fromName != null) return fromName
        return mimeType?.substringBefore(';')?.let {
            MimeTypeMap.getSingleton().getExtensionFromMimeType(it)
        }?.lowercase(Locale.ROOT)?.takeIf { it.matches(Regex("[a-z0-9]{1,10}")) }
    }
}
