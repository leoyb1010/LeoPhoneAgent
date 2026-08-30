package com.leoyuan.leophoneagent.data.repository

import androidx.sqlite.db.SimpleSQLiteQuery
import com.leoyuan.leophoneagent.data.db.TreasureChangeEntity
import com.leoyuan.leophoneagent.data.db.TreasureCaptureBundle
import com.leoyuan.leophoneagent.data.db.TreasureDao
import com.leoyuan.leophoneagent.data.db.TreasureItemEntity
import com.leoyuan.leophoneagent.data.db.TreasureJobEntity
import java.io.File
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.decodeFromJsonElement

@Serializable
data class TreasureItemRecord(
    val id: String = UUID.randomUUID().toString(),
    @SerialName("schema_version") val schemaVersion: Int = 1,
    val kind: String,
    val title: String? = null,
    @SerialName("source_uri") val sourceUri: String? = null,
    @SerialName("source_app") val sourceApp: String? = null,
    @SerialName("source_label") val sourceLabel: String,
    @SerialName("original_text") val originalText: String? = null,
    @SerialName("body_ref") val bodyRef: String? = null,
    @SerialName("preview_ref") val previewRef: String? = null,
    @SerialName("mime_type") val mimeType: String? = null,
    @SerialName("byte_count") val byteCount: Long = 0,
    @SerialName("content_digest") val contentDigest: String? = null,
    val summary: String? = null,
    val annotation: String? = null,
    val tags: List<String> = emptyList(),
    @SerialName("collection_ids") val collectionIds: List<String> = emptyList(),
    val pinned: Boolean = false,
    val archived: Boolean = false,
    @SerialName("reading_state") val readingState: String = "none",
    @SerialName("reading_progress") val readingProgress: Double = 0.0,
    @SerialName("created_at") val createdAt: String = Instant.now().toString(),
    @SerialName("updated_at") val updatedAt: String = createdAt,
    @SerialName("last_opened_at") val lastOpenedAt: String? = null,
    @SerialName("processing_state") val processingState: String = "saved",
    @SerialName("processing_error_code") val processingErrorCode: String? = null,
    @SerialName("sync_state") val syncState: String = "local",
    @SerialName("origin_device_id") val originDeviceId: String,
    @SerialName("deleted_at") val deletedAt: String? = null,
)

data class TreasureImportReport(
    val importedCount: Int,
    val duplicateCount: Int,
    val quarantinedCount: Int,
)

class TreasureRepository(
    private val dao: TreasureDao,
    private val filesDirectory: File,
    private val originDeviceId: () -> String,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun observeItems(limit: Int = 100, offset: Int = 0): Flow<List<TreasureItemEntity>> =
        dao.observeItems(limit.coerceIn(1, 500), offset.coerceAtLeast(0))

    suspend fun save(record: TreasureItemRecord): TreasureItemEntity {
        val entity = validatedEntity(record)
        val now = System.currentTimeMillis()
        val jobs = buildList {
            if (record.kind == "link") add(job(record.id, "metadata", now))
            add(job(record.id, "index", now))
        }
        return dao.insertCaptured(entity, jobs, change(record, "upsert", now))
    }

    suspend fun update(record: TreasureItemRecord) {
        val existing = dao.getIncludingDeleted(record.id) ?: return
        if (existing.deletedAt != null) return
        val entity = validatedEntity(record).copy(rowId = existing.rowId)
        dao.updateWithChange(entity, change(record, "upsert", System.currentTimeMillis()))
    }

    suspend fun tombstone(ids: List<String>): Int {
        val safeIds = ids.distinct().filter { it.isNotBlank() }.take(500)
        if (safeIds.isEmpty()) return 0
        val existingIds = dao.getByIds(safeIds).map { it.id }
        if (existingIds.isEmpty()) return 0
        val now = System.currentTimeMillis()
        val changes = existingIds.map { id ->
            TreasureChangeEntity(
                changeId = UUID.randomUUID().toString(), itemId = id,
                operation = "delete", updatedAt = now,
                originDeviceId = originDeviceId(), payloadDigest = sha256("delete:$id:$now"),
            )
        }
        return dao.tombstoneWithChanges(existingIds, now, changes)
    }

    fun search(query: String, limit: Int = 50): Flow<List<TreasureItemEntity>> {
        val expression = ftsExpression(query)
        if (expression.isEmpty()) return dao.observeItems(limit.coerceIn(1, 100), 0)
        return dao.search(
            SimpleSQLiteQuery(
                """
                SELECT treasure_items.* FROM treasure_search_fts
                JOIN treasure_items ON treasure_items.row_id = treasure_search_fts.rowid
                WHERE treasure_search_fts MATCH ? AND treasure_items.deleted_at IS NULL
                ORDER BY treasure_items.updated_at DESC LIMIT ?
                """.trimIndent(),
                arrayOf<Any>(expression, limit.coerceIn(1, 100)),
            )
        )
    }

    suspend fun readyJobs(now: Long = System.currentTimeMillis(), limit: Int = 50) =
        dao.readyJobs(now, limit.coerceIn(1, 500))

    suspend fun claimJob(id: String, now: Long = System.currentTimeMillis()): Boolean =
        dao.claimJob(id, now) > 0

    suspend fun completeJob(id: String, now: Long = System.currentTimeMillis()): Boolean =
        dao.completeJob(id, now) > 0

    suspend fun failJob(id: String, errorCode: String, now: Long = System.currentTimeMillis()): Boolean {
        val attempt = (dao.getJob(id)?.attemptCount ?: return false).coerceIn(1, 16)
        val delay = (1_000L shl attempt).coerceAtMost(86_400_000L)
        val safeCode = errorCode.filter { it.isLetterOrDigit() || it == '_' || it == '-' }
            .take(80).ifEmpty { "unknown" }
        return dao.failJob(id, now, now + delay, safeCode) > 0
    }

    suspend fun changes(after: Long, limit: Int = 500) =
        dao.changes(after.coerceAtLeast(0), limit.coerceIn(1, 1_000))

    suspend fun rebuildIndex() = dao.rebuildSearchIndex()

    fun exportJson(records: List<TreasureItemRecord>): String = json.encodeToString(records)

    fun importJson(payload: String): List<TreasureItemRecord> = json.decodeFromString(payload)

    suspend fun importJsonAndSave(payload: String): TreasureImportReport {
        val values = runCatching { json.parseToJsonElement(payload) as? JsonArray }
            .getOrNull() ?: throw IllegalArgumentException("Treasury import must be an array")
        val bundles = mutableListOf<TreasureCaptureBundle>()
        val seenIds = mutableSetOf<String>()
        val seenUrls = mutableSetOf<String>()
        val seenDigests = mutableSetOf<String>()
        var duplicateCount = 0
        var quarantinedCount = 0
        for (value in values) {
            val record = try {
                json.decodeFromJsonElement<TreasureItemRecord>(value)
            } catch (_: Exception) {
                quarantinedCount += 1
                continue
            }
            val entity = try {
                validatedEntity(record)
            } catch (_: IllegalArgumentException) {
                quarantinedCount += 1
                continue
            } catch (_: java.time.DateTimeException) {
                quarantinedCount += 1
                continue
            }
            val normalized = entity.normalizedUrlKey
            val digest = entity.contentDigest
            val duplicate = !seenIds.add(record.id) ||
                (normalized != null && !seenUrls.add(normalized)) ||
                (digest != null && !seenDigests.add(digest)) ||
                dao.getIncludingDeleted(record.id) != null ||
                (normalized != null && dao.findByNormalizedUrl(normalized) != null) ||
                (digest != null && dao.findByDigest(digest) != null)
            if (duplicate) {
                duplicateCount += 1
                continue
            }
            val now = System.currentTimeMillis()
            val jobs = buildList {
                if (record.kind == "link") add(job(record.id, "metadata", now))
                add(job(record.id, "index", now))
            }
            bundles += TreasureCaptureBundle(entity, jobs, change(record, "upsert", now))
        }
        val insertedCount = dao.insertCapturedBatch(bundles)
        duplicateCount += bundles.size - insertedCount
        return TreasureImportReport(insertedCount, duplicateCount, quarantinedCount)
    }

    fun exportMarkdown(records: List<TreasureItemRecord>): String = records.joinToString("\n\n---\n\n") {
        val heading = it.title?.takeIf(String::isNotBlank) ?: it.sourceLabel
        val source = it.sourceUri?.let { uri -> "\n\nSource: $uri" }.orEmpty()
        val body = it.originalText?.let { text -> "\n\n$text" }.orEmpty()
        val tags = it.tags.takeIf(List<String>::isNotEmpty)
            ?.joinToString(" ", prefix = "\n\nTags: ") { tag -> "#$tag" }.orEmpty()
        "## $heading$source$body$tags"
    }

    fun importMarkdown(markdown: String, deviceId: String = originDeviceId()): List<TreasureItemRecord> =
        parseMarkdown(markdown, deviceId)

    fun importBrowserBookmarksHtml(html: String): List<TreasureItemRecord> =
        BOOKMARK_PATTERN.findAll(html).mapNotNull { match ->
            val rawUrl = match.groupValues[1]
            val uri = runCatching { URI(rawUrl) }.getOrNull()
            val host = uri?.host ?: return@mapNotNull null
            if (uri.scheme?.lowercase() !in setOf("http", "https")) return@mapNotNull null
            val title = match.groupValues[2].replace(TAG_PATTERN, "").trim().ifBlank { null }
            TreasureItemRecord(
                kind = "link", title = title, sourceUri = rawUrl,
                sourceLabel = host, originDeviceId = originDeviceId(),
            )
        }.toList()

    fun digestAsset(relativeRef: String): String? {
        if (!isSafeRelativeRef(relativeRef)) return null
        val file = File(filesDirectory, relativeRef)
        val canonicalRoot = filesDirectory.canonicalFile
        val canonicalFile = file.canonicalFile
        if (!canonicalFile.path.startsWith(canonicalRoot.path + File.separator) || !canonicalFile.isFile) return null
        val digest = MessageDigest.getInstance("SHA-256")
        canonicalFile.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun TreasureItemRecord.toEntity(normalizedUrl: String?, digest: String?) =
        TreasureItemEntity(
            id = id, schemaVersion = schemaVersion, kind = kind, title = title,
            sourceUri = sourceUri, normalizedUrlKey = normalizedUrl, sourceApp = sourceApp,
            sourceLabel = sourceLabel, originalText = originalText, bodyRef = bodyRef,
            previewRef = previewRef, mimeType = mimeType, byteCount = byteCount,
            contentDigest = digest, summary = summary, annotation = annotation,
            tagsJson = json.encodeToString(normalizedTags(tags)),
            collectionIdsJson = json.encodeToString(collectionIds.distinct()),
            pinned = pinned, archived = archived, readingState = readingState,
            readingProgress = readingProgress, createdAt = Instant.parse(createdAt).toEpochMilli(),
            updatedAt = Instant.parse(updatedAt).toEpochMilli(),
            lastOpenedAt = lastOpenedAt?.let { Instant.parse(it).toEpochMilli() },
            processingState = processingState, processingErrorCode = processingErrorCode,
            syncState = syncState, originDeviceId = originDeviceId,
            deletedAt = deletedAt?.let { Instant.parse(it).toEpochMilli() },
        )

    private fun validatedEntity(record: TreasureItemRecord): TreasureItemEntity {
        require(record.id.isNotBlank()) { "Missing treasure id" }
        require(record.kind in ALLOWED_KINDS) { "Unsupported treasure kind" }
        require(record.readingProgress in 0.0..1.0) { "reading_progress must be in 0...1" }
        require(record.byteCount >= 0) { "byte_count must be non-negative" }
        require(record.readingState in READING_STATES) { "Unsupported reading_state" }
        require(record.processingState in PROCESSING_STATES) { "Unsupported processing_state" }
        require(record.syncState in SYNC_STATES) { "Unsupported sync_state" }
        require(isSafeRelativeRef(record.bodyRef) && isSafeRelativeRef(record.previewRef)) {
            "Unsafe local reference"
        }
        record.contentDigest?.let {
            require(DIGEST_PATTERN.matches(it)) { "Invalid content_digest" }
        }
        val normalizedUrl = record.sourceUri?.let(::normalizedUrlKey)
        if (record.sourceUri != null || record.kind == "link") {
            require(normalizedUrl != null) { "Invalid source_uri" }
        }
        return record.toEntity(normalizedUrl, record.contentDigest?.lowercase())
    }

    private fun job(itemId: String, type: String, now: Long) = TreasureJobEntity(
        id = UUID.randomUUID().toString(), itemId = itemId, jobType = type,
        createdAt = now, updatedAt = now,
    )

    private fun change(record: TreasureItemRecord, operation: String, now: Long) =
        TreasureChangeEntity(
            changeId = UUID.randomUUID().toString(), itemId = record.id,
            operation = operation, updatedAt = now, originDeviceId = originDeviceId(),
            payloadDigest = sha256(json.encodeToString(record)),
        )

    companion object {
        private val ALLOWED_KINDS = setOf("link", "text", "note", "image", "document", "audio", "video", "artifact")
        private val READING_STATES = setOf("none", "unread", "reading", "read")
        private val PROCESSING_STATES = setOf("saved", "queued", "processing", "ready", "partial", "failed")
        private val SYNC_STATES = setOf("local", "pending", "synced", "conflict", "remote_only")
        private val DIGEST_PATTERN = Regex("^[0-9a-fA-F]{64}$")
        private val TRACKING_KEYS = setOf("fbclid", "gclid", "mc_cid", "mc_eid")
        private val BOOKMARK_PATTERN = Regex("""<a\b[^>]*href\s*=\s*[\"']([^\"']+)[\"'][^>]*>(.*?)</a>""", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
        private val TAG_PATTERN = Regex("<[^>]+>")

        fun parseMarkdown(markdown: String, deviceId: String): List<TreasureItemRecord> =
            markdown.split("\n\n---\n\n").mapNotNull { section ->
            val lines = section.lines()
            val headingLine = lines.firstOrNull { it.isNotBlank() } ?: return@mapNotNull null
            val title = headingLine.replace(Regex("^#{1,6}\\s*"), "").trim().ifBlank { null }
            val source = lines.firstOrNull { it.startsWith("Source: ") }
                ?.removePrefix("Source: ")?.trim()
            val tags = lines.firstOrNull { it.startsWith("Tags: ") }
                ?.removePrefix("Tags: ")?.split(Regex("\\s+"))
                ?.map { it.removePrefix("#") }?.filter(String::isNotBlank).orEmpty()
            val now = Instant.now().toString()
            if (source != null && normalizedUrlKey(source) != null) {
                val host = runCatching { URI(source).host }.getOrNull() ?: "网页"
                TreasureItemRecord(
                    kind = "link", title = title, sourceUri = source, sourceLabel = host,
                    tags = tags, readingState = "unread", processingState = "queued",
                    originDeviceId = deviceId, createdAt = now, updatedAt = now,
                )
            } else {
                val body = lines.drop(1)
                    .filterNot { it.startsWith("Source: ") || it.startsWith("Tags: ") }
                    .joinToString("\n").trim()
                if (body.isEmpty() && title == null) return@mapNotNull null
                TreasureItemRecord(
                    kind = "text", title = title, sourceLabel = "文本", originalText = body,
                    tags = tags, originDeviceId = deviceId, createdAt = now, updatedAt = now,
                )
            }
            }

        fun normalizedUrlKey(raw: String): String? = runCatching {
            val uri = URI(raw.trim())
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host?.lowercase() ?: return null
            if (scheme !in setOf("http", "https")) return null
            val port = when {
                scheme == "http" && uri.port == 80 -> -1
                scheme == "https" && uri.port == 443 -> -1
                else -> uri.port
            }
            val query = uri.rawQuery?.split('&')?.mapNotNull { part ->
                val name = part.substringBefore('=').lowercase()
                part.takeUnless { name.startsWith("utm_") || name in TRACKING_KEYS }
            }?.sorted()?.joinToString("&")?.ifBlank { null }
            URI(scheme, uri.userInfo, host, port, uri.rawPath.ifBlank { "/" }, query, null).toASCIIString()
        }.getOrNull()

        fun isSafeRelativeRef(value: String?): Boolean {
            if (value == null) return true
            if (value.isBlank() || value.startsWith('/') || value.startsWith('\\') ||
                value.contains('\u0000') || Regex("^[A-Za-z]:[\\\\/]").containsMatchIn(value)) return false
            return value.split('/', '\\').none { it.isBlank() || it == "." || it == ".." }
        }

        fun normalizedTags(tags: List<String>): List<String> {
            val seen = mutableSetOf<String>()
            return tags.map(String::trim).filter { it.isNotEmpty() && seen.add(it.lowercase()) }
        }

        fun ftsExpression(raw: String): String = raw.trim().take(512)
            .split(Regex("\\s+"))
            .map { it.replace("\"", "\"\"") }
            .filter(String::isNotEmpty)
            .joinToString(" AND ") { "\"$it\"*" }

        private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
