package com.leoyuan.leophoneagent.data.repository

import androidx.sqlite.db.SimpleSQLiteQuery
import com.leoyuan.leophoneagent.data.db.TreasureChangeEntity
import com.leoyuan.leophoneagent.data.db.TreasureCaptureBundle
import com.leoyuan.leophoneagent.data.db.TreasureChunkEntity
import com.leoyuan.leophoneagent.data.db.TreasureDao
import com.leoyuan.leophoneagent.data.db.TreasureItemEntity
import com.leoyuan.leophoneagent.data.db.TreasureJobEntity
import com.leoyuan.leophoneagent.data.db.TreasureHighlightEntity
import com.leoyuan.leophoneagent.data.db.TreasureSearchRow
import com.leoyuan.leophoneagent.treasury.TreasuryQuery
import java.io.File
import java.net.URI
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.Locale
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.decodeFromJsonElement
import org.json.JSONObject

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

data class TreasureRemoteChange(
    val sequence: Long,
    val changeId: String,
    val itemId: String,
    val operation: String,
    val updatedAt: Long,
    val originDeviceId: String,
    val payloadDigest: String,
    val record: TreasureItemRecord?,
)

data class TreasureSyncAsset(
    val file: File,
    val mimeType: String,
    val byteCount: Long,
    val digest: String,
    val removeAfterUpload: Boolean,
)

class TreasureRepository(
    private val dao: TreasureDao,
    private val filesDirectory: File,
    private val originDeviceId: () -> String,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun observeItems(limit: Int = 100, offset: Int = 0): Flow<List<TreasureItemEntity>> =
        dao.observeItems(limit.coerceIn(1, 500), offset.coerceAtLeast(0))

    fun localOriginDeviceId(): String = originDeviceId()

    suspend fun get(ids: List<String>): List<TreasureItemEntity> =
        dao.getByIds(ids.distinct().filter(String::isNotBlank).take(100))

    suspend fun changes(after: Long, limit: Int = 500): List<TreasureChangeEntity> =
        dao.changes(after.coerceAtLeast(0), limit.coerceIn(1, 1_000))

    suspend fun recordsIncludingDeleted(ids: List<String>): Map<String, TreasureItemRecord> =
        dao.getManyIncludingDeleted(ids.distinct().filter(String::isNotBlank).take(1_000))
            .associate { it.id to it.toRecord() }

    suspend fun syncAsset(itemId: String, kind: String): TreasureSyncAsset? {
        if (kind !in setOf("body", "attachment")) return null
        val item = dao.getById(itemId) ?: return null
        if (kind == "body") {
            val body = item.originalText ?: item.bodyRef?.let { ref ->
                managedFile(ref, 8L * 1024 * 1024)?.readText(Charsets.UTF_8)
            } ?: return null
            val bytes = body.toByteArray(Charsets.UTF_8)
            if (bytes.size > 8 * 1024 * 1024) return null
            val outbox = File(filesDirectory, "sync-outbox").apply { mkdirs() }
            val temporary = File.createTempFile("body-", ".txt", outbox)
            return try {
                temporary.writeBytes(bytes)
                TreasureSyncAsset(
                    file = temporary, mimeType = "text/plain", byteCount = bytes.size.toLong(),
                    digest = sha256File(temporary) ?: run { temporary.delete(); return null },
                    removeAfterUpload = true,
                )
            } catch (_: Exception) {
                temporary.delete()
                null
            }
        }
        if (item.kind !in setOf("image", "document", "audio", "video", "artifact")) return null
        val ref = item.bodyRef ?: return null
        val file = managedFile(ref, 128L * 1024 * 1024) ?: return null
        val digest = sha256File(file) ?: return null
        if ((item.byteCount > 0 && item.byteCount != file.length()) ||
            (item.contentDigest != null && !item.contentDigest.equals(digest, ignoreCase = true))) return null
        return TreasureSyncAsset(
            file = file, mimeType = item.mimeType ?: "application/octet-stream",
            byteCount = file.length(), digest = digest, removeAfterUpload = false,
        )
    }

    suspend fun applyRemoteChanges(changes: List<TreasureRemoteChange>): Int {
        var applied = 0
        for (change in changes.sortedBy(TreasureRemoteChange::sequence)) {
            if (change.originDeviceId == originDeviceId() ||
                change.operation !in setOf("upsert", "delete") || change.itemId.isBlank()) continue
            val incoming = if (change.operation == "upsert") {
                val record = change.record ?: continue
                if (record.id != change.itemId || record.originDeviceId != change.originDeviceId) continue
                runCatching { validatedEntity(record.copy(syncState = "remote_only")) }.getOrNull() ?: continue
            } else {
                val existing = dao.getIncludingDeleted(change.itemId)
                (existing ?: TreasureItemEntity(
                    id = change.itemId, kind = "text", sourceLabel = "同步删除",
                    createdAt = change.updatedAt, updatedAt = change.updatedAt,
                    processingState = "saved", syncState = "remote_only",
                    originDeviceId = change.originDeviceId, deletedAt = change.updatedAt,
                )).copy(
                    updatedAt = change.updatedAt,
                    syncState = "remote_only",
                    originDeviceId = change.originDeviceId,
                    deletedAt = change.updatedAt,
                )
            }
            if (dao.applyRemoteItem(incoming, change.operation, change.changeId, originDeviceId())) applied += 1
        }
        return applied
    }

    suspend fun save(record: TreasureItemRecord): TreasureItemEntity {
        val entity = validatedEntity(record)
        val now = System.currentTimeMillis()
        val jobs = buildList {
            when (record.kind) {
                "link" -> add(job(record.id, "metadata", now))
                "image" -> add(job(record.id, "ocr", now))
                "document" -> add(job(record.id, "extract_text", now))
                "audio" -> add(job(record.id, "transcribe", now))
            }
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

    fun search(
        query: String,
        limit: Int = 50,
        kinds: List<String> = emptyList(),
        tags: List<String> = emptyList(),
        sourceLabels: List<String> = emptyList(),
        collectionIds: List<String> = emptyList(),
        readingStates: List<String> = emptyList(),
        includeArchived: Boolean? = null,
        createdAfter: Long? = null,
        createdBefore: Long? = null,
    ): Flow<List<TreasureSearchRow>> {
        val spec = TreasuryQuery.parse(query)
        val expression = ftsExpression(spec.textQuery)
        val args = mutableListOf<Any>()
        val from = if (expression.isNotEmpty()) {
            args += expression
            "treasure_search_fts JOIN treasure_items ON treasure_items.row_id = treasure_search_fts.rowid"
        } else {
            "treasure_items"
        }
        val where = mutableListOf("treasure_items.deleted_at IS NULL")
        if (expression.isNotEmpty()) where += "treasure_search_fts MATCH ?"
        when (includeArchived) {
            true -> Unit
            false -> where += "treasure_items.archived = 0"
            null -> where += if (spec.archived) "treasure_items.archived = 1" else "treasure_items.archived = 0"
        }
        if (spec.kinds.isNotEmpty()) {
            where += "treasure_items.kind IN (${spec.kinds.joinToString(",") { "?" }})"
            args.addAll(spec.kinds)
        }
        val explicitKinds = kinds.map { it.trim().lowercase(Locale.ROOT) }
            .filter(ALLOWED_KINDS::contains).distinct()
        if (explicitKinds.isNotEmpty()) {
            where += "treasure_items.kind IN (${explicitKinds.joinToString(",") { "?" }})"
            args.addAll(explicitKinds)
        }
        if (spec.processingStates.isNotEmpty()) {
            where += "treasure_items.processing_state IN (${spec.processingStates.joinToString(",") { "?" }})"
            args.addAll(spec.processingStates)
        }
        if (spec.readingStates.isNotEmpty()) {
            where += "treasure_items.reading_state IN (${spec.readingStates.joinToString(",") { "?" }})"
            args.addAll(spec.readingStates)
        }
        val explicitReading = readingStates.map { it.trim().lowercase(Locale.ROOT) }
            .filter(READING_STATES::contains).distinct()
        if (explicitReading.isNotEmpty()) {
            where += "treasure_items.reading_state IN (${explicitReading.joinToString(",") { "?" }})"
            args.addAll(explicitReading)
        }
        spec.pinned?.let {
            where += "treasure_items.pinned = ?"
            args += if (it) 1 else 0
        }
        spec.tags.forEach { tag ->
            where += "treasure_items.tags_json LIKE ? ESCAPE '\\'"
            args += "%${escapeLike(JSONObject.quote(tag))}%"
        }
        normalizedTags(tags).take(100).forEach { tag ->
            where += "treasure_items.tags_json LIKE ? ESCAPE '\\'"
            args += "%${escapeLike(JSONObject.quote(tag))}%"
        }
        val safeSources = sourceLabels.map(String::trim).filter(String::isNotEmpty)
            .map { it.take(200).lowercase(Locale.ROOT) }.distinct().take(100)
        if (safeSources.isNotEmpty()) {
            where += "LOWER(treasure_items.source_label) IN (${safeSources.joinToString(",") { "?" }})"
            args.addAll(safeSources)
        }
        normalizedCollectionIds(collectionIds).forEach { id ->
            where += "treasure_items.collection_ids_json LIKE ? ESCAPE '\\'"
            args += "%${escapeLike(JSONObject.quote(id))}%"
        }
        (createdAfter ?: spec.afterEpochMs)?.let {
            where += "treasure_items.created_at >= ?"
            args += it
        }
        (createdBefore ?: spec.beforeEpochMs)?.let {
            where += "treasure_items.created_at < ?"
            args += it
        }
        val snippet = if (expression.isNotEmpty()) {
            "snippet(treasure_search_fts, '', '', '…', -1, 48)"
        } else {
            "substr(COALESCE(NULLIF(treasure_items.summary, ''), NULLIF(treasure_items.original_text, ''), treasure_items.source_uri, treasure_items.processing_error_code, ''), 1, 400)"
        }
        val offsets = if (expression.isNotEmpty()) "offsets(treasure_search_fts)" else "''"
        val order = if (spec.recent) {
            "treasure_items.pinned DESC, COALESCE(treasure_items.last_opened_at, 0) DESC, treasure_items.updated_at DESC"
        } else {
            "treasure_items.pinned DESC, treasure_items.updated_at DESC"
        }
        args += limit.coerceIn(1, 500)
        return dao.searchRows(SimpleSQLiteQuery(
            """
            SELECT treasure_items.stable_id, treasure_items.kind, treasure_items.title,
                   treasure_items.source_uri, treasure_items.source_label,
                   $snippet AS snippet, $offsets AS match_offsets,
                   treasure_items.tags_json, treasure_items.pinned, treasure_items.archived,
                   treasure_items.reading_state, treasure_items.reading_progress,
                   treasure_items.last_opened_at, treasure_items.processing_state,
                   treasure_items.processing_error_code, treasure_items.created_at,
                   treasure_items.updated_at
            FROM $from
            WHERE ${where.joinToString(" AND ")}
            ORDER BY $order LIMIT ?
            """.trimIndent(),
            args.toTypedArray(),
        ))
    }

    fun observeHighlights(itemId: String): Flow<List<TreasureHighlightEntity>> =
        dao.observeHighlights(itemId)

    suspend fun addHighlight(
        itemId: String,
        startOffset: Int,
        endOffset: Int,
        quoteText: String,
        note: String? = null,
        pageNumber: Int? = null,
    ): TreasureHighlightEntity {
        val item = dao.getById(itemId) ?: throw IllegalArgumentException("Treasury item not found")
        val body = item.originalText ?: throw IllegalArgumentException("Treasury body is unavailable")
        require(startOffset >= 0 && endOffset > startOffset && endOffset <= body.length) { "Invalid highlight range" }
        val normalizedQuote = quoteText.take(20_000)
        require(body.substring(startOffset, endOffset) == normalizedQuote) { "Highlight quote no longer matches body" }
        val now = System.currentTimeMillis()
        val highlight = TreasureHighlightEntity(
            id = UUID.randomUUID().toString(), itemId = itemId, quoteText = normalizedQuote,
            note = note?.trim()?.takeIf(String::isNotEmpty)?.take(20_000),
            startOffset = startOffset, endOffset = endOffset,
            pageNumber = pageNumber?.takeIf { it > 0 }, createdAt = now, updatedAt = now,
            originDeviceId = originDeviceId(),
        )
        check(dao.addHighlight(
            highlight,
            stateChange(
                itemId, "highlight", null, now,
                sha256("${highlight.id}\u0000$itemId\u0000$startOffset\u0000$endOffset\u0000$normalizedQuote\u0000${highlight.note.orEmpty()}"),
            ),
        )) { "Unable to save highlight" }
        return highlight
    }

    suspend fun deleteHighlight(id: String): Boolean {
        val highlight = dao.getHighlight(id) ?: return false
        val now = System.currentTimeMillis()
        return dao.deleteHighlight(
            id, highlight.itemId, now,
            stateChange(highlight.itemId, "highlight_deleted", null, now, sha256("highlight-delete:$id:$now")),
        )
    }

    suspend fun readyJobs(now: Long = System.currentTimeMillis(), limit: Int = 50) =
        dao.readyJobs(now, limit.coerceIn(1, 500))

    suspend fun hasPendingAutomaticJobs(): Boolean = dao.pendingAutomaticJobCount() > 0

    suspend fun recoverInterruptedJobs(
        staleBefore: Long = System.currentTimeMillis() - 15L * 60L * 1000L,
        now: Long = System.currentTimeMillis(),
    ): Int {
        val itemIds = dao.staleProcessingItemIds(staleBefore)
        val recovered = dao.recoverStaleJobs(staleBefore, now)
        itemIds.forEach { markProcessingFailed(it, "process_interrupted") }
        return recovered
    }

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

    suspend fun retryFailedJobs(itemId: String): Int =
        dao.retryFailedJobs(itemId, System.currentTimeMillis())

    suspend fun markProcessing(itemId: String): Boolean =
        updateProcessingState(itemId, "processing", null)

    suspend fun markProcessingFailed(itemId: String, errorCode: String): Boolean {
        val safeCode = errorCode.filter { it.isLetterOrDigit() || it == '_' || it == '-' }
            .take(80).ifEmpty { "unknown" }
        return updateProcessingState(itemId, "failed", safeCode)
    }

    suspend fun markPartial(itemId: String, errorCode: String): Boolean {
        val safeCode = errorCode.filter { it.isLetterOrDigit() || it == '_' || it == '-' }
            .take(80).ifEmpty { "unavailable" }
        return updateProcessingState(itemId, "partial", safeCode)
    }

    suspend fun markIndexed(itemId: String): Boolean {
        val now = System.currentTimeMillis()
        return dao.markIndexed(itemId, now, stateChange(itemId, "ready", null, now)) > 0
    }

    suspend fun applyEnhancement(
        itemId: String,
        title: String? = null,
        originalText: String? = null,
        state: String = "ready",
    ): Boolean {
        val safeTitle = title?.trim()?.take(500)
        val safeText = originalText?.take(2_000_000)
        val safeState = state.takeIf { it in PROCESSING_STATES } ?: "partial"
        val now = System.currentTimeMillis()
        val digestValue = listOf(itemId, safeTitle.orEmpty(), safeText.orEmpty(), safeState, now.toString())
            .joinToString("\u0000")
        return dao.applyEnhancement(
            itemId = itemId,
            title = safeTitle,
            originalText = safeText,
            state = safeState,
            now = now,
            change = stateChange(itemId, safeState, null, now, sha256(digestValue)),
        ) > 0
    }

    suspend fun applyDocumentExtraction(itemId: String, pages: List<String>): Boolean {
        val boundedPages = pages.take(500)
        val combined = StringBuilder()
        val chunks = mutableListOf<TreasureChunkEntity>()
        for ((index, raw) in boundedPages.withIndex()) {
            val text = raw.trim().take(200_000)
            if (text.isEmpty()) continue
            val marker = "【第 ${index + 1} 页】\n"
            if (combined.length + marker.length + text.length > 2_000_000) break
            val start = combined.length
            combined.append(marker).append(text).append('\n')
            chunks += TreasureChunkEntity(
                itemId = itemId, chunkIndex = chunks.size,
                sectionLabel = "page:${index + 1}", text = text,
                startOffset = start + marker.length,
                endOffset = start + marker.length + text.length,
            )
        }
        if (chunks.isEmpty()) return false
        val body = combined.toString().trimEnd()
        val now = System.currentTimeMillis()
        return dao.applyDocumentExtraction(
            itemId = itemId, originalText = body, chunks = chunks, now = now,
            change = stateChange(itemId, "ready", null, now, sha256(body)),
        ) > 0
    }

    suspend fun rebuildIndex() = dao.rebuildSearchIndex()

    suspend fun updateItem(
        id: String,
        title: String? = null,
        tags: List<String>? = null,
        pinned: Boolean? = null,
        archived: Boolean? = null,
        readingState: String? = null,
        readingProgress: Double? = null,
        lastOpenedAt: Long? = null,
        annotation: String? = null,
        collectionIds: List<String>? = null,
    ): TreasureItemEntity? {
        val existing = dao.getIncludingDeleted(id) ?: return null
        if (existing.deletedAt != null) return null
        val requestedReadingState = readingState?.takeIf { it in READING_STATES }
        val normalizedReadingProgress = when (requestedReadingState) {
            "none", "unread" -> 0.0
            "read" -> 1.0
            else -> readingProgress?.coerceIn(0.0, 1.0) ?: existing.readingProgress
        }
        val normalizedReadingState = when {
            requestedReadingState == "reading" && normalizedReadingProgress >= 1.0 -> "read"
            requestedReadingState != null -> requestedReadingState
            readingProgress != null && normalizedReadingProgress >= 1.0 -> "read"
            readingProgress != null -> "reading"
            else -> existing.readingState
        }
        val updated = existing.copy(
            title = title?.trim()?.take(500) ?: existing.title,
            tagsJson = tags?.let { json.encodeToString(normalizedTags(it).take(100)) } ?: existing.tagsJson,
            pinned = pinned ?: existing.pinned,
            archived = archived ?: existing.archived,
            readingState = normalizedReadingState,
            readingProgress = normalizedReadingProgress,
            lastOpenedAt = lastOpenedAt ?: existing.lastOpenedAt,
            annotation = annotation?.take(20_000) ?: existing.annotation,
            collectionIdsJson = collectionIds?.let {
                json.encodeToString(normalizedCollectionIds(it))
            } ?: existing.collectionIdsJson,
            updatedAt = System.currentTimeMillis(),
            syncState = "pending",
        )
        val record = updated.toRecord()
        return if (dao.updateWithChange(updated, change(record, "upsert", updated.updatedAt))) updated else null
    }

    suspend fun markOpened(id: String): TreasureItemEntity? {
        val existing = dao.getById(id) ?: return null
        return updateItem(
            id = id,
            readingState = if (existing.readingState == "unread") "reading" else existing.readingState,
            lastOpenedAt = System.currentTimeMillis(),
        )
    }

    suspend fun updateReadingProgress(id: String, progress: Double): TreasureItemEntity? =
        updateItem(
            id = id,
            readingProgress = progress,
            readingState = if (progress >= 1.0) "read" else "reading",
            lastOpenedAt = System.currentTimeMillis(),
        )

    fun record(entity: TreasureItemEntity): TreasureItemRecord = entity.toRecord()

    private suspend fun updateProcessingState(itemId: String, state: String, errorCode: String?): Boolean {
        val now = System.currentTimeMillis()
        return dao.updateProcessingState(
            itemId,
            state,
            errorCode,
            now,
            stateChange(itemId, state, errorCode, now),
        ) > 0
    }

    private fun stateChange(
        itemId: String,
        state: String,
        errorCode: String?,
        now: Long,
        digest: String = sha256("processing:$itemId:$state:${errorCode.orEmpty()}:$now"),
    ) = TreasureChangeEntity(
        changeId = UUID.randomUUID().toString(),
        itemId = itemId,
        operation = "upsert",
        updatedAt = now,
        originDeviceId = originDeviceId(),
        payloadDigest = digest,
    )

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
                when (record.kind) {
                    "link" -> add(job(record.id, "metadata", now))
                    "image" -> add(job(record.id, "ocr", now))
                    "document" -> add(job(record.id, "extract_text", now))
                    "audio" -> add(job(record.id, "transcribe", now))
                }
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
            if (uri.scheme?.lowercase(Locale.ROOT) !in setOf("http", "https")) return@mapNotNull null
            val title = match.groupValues[2].replace(TAG_PATTERN, "").trim().ifBlank { null }
            TreasureItemRecord(
                kind = "link", title = title, sourceUri = rawUrl,
                sourceLabel = host, originDeviceId = originDeviceId(),
            )
        }.toList()

    fun digestAsset(relativeRef: String): String? {
        val canonicalFile = managedFile(relativeRef, Long.MAX_VALUE) ?: return null
        return sha256File(canonicalFile)
    }

    private fun managedFile(relativeRef: String, maxBytes: Long): File? {
        if (!isSafeRelativeRef(relativeRef)) return null
        val file = File(filesDirectory, relativeRef)
        val canonicalRoot = filesDirectory.canonicalFile
        val canonicalFile = file.canonicalFile
        if (!canonicalFile.path.startsWith(canonicalRoot.path + File.separator) ||
            !canonicalFile.isFile || canonicalFile.length() > maxBytes) return null
        return canonicalFile
    }

    private fun sha256File(file: File): String? = runCatching {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        digest.digest().joinToString("") { "%02x".format(it) }
    }.getOrNull()

    private fun TreasureItemRecord.toEntity(normalizedUrl: String?, digest: String?) =
        TreasureItemEntity(
            id = id, schemaVersion = schemaVersion, kind = kind, title = title,
            sourceUri = sourceUri, normalizedUrlKey = normalizedUrl, sourceApp = sourceApp,
            sourceLabel = sourceLabel, originalText = originalText, bodyRef = bodyRef,
            previewRef = previewRef, mimeType = mimeType, byteCount = byteCount,
            contentDigest = digest, summary = summary, annotation = annotation,
            tagsJson = json.encodeToString(normalizedTags(tags)),
            collectionIdsJson = json.encodeToString(normalizedCollectionIds(collectionIds)),
            pinned = pinned, archived = archived, readingState = readingState,
            readingProgress = readingProgress, createdAt = Instant.parse(createdAt).toEpochMilli(),
            updatedAt = Instant.parse(updatedAt).toEpochMilli(),
            lastOpenedAt = lastOpenedAt?.let { Instant.parse(it).toEpochMilli() },
            processingState = processingState, processingErrorCode = processingErrorCode,
            syncState = syncState, originDeviceId = originDeviceId,
            deletedAt = deletedAt?.let { Instant.parse(it).toEpochMilli() },
        )

    private fun TreasureItemEntity.toRecord() = TreasureItemRecord(
        id = id,
        schemaVersion = schemaVersion,
        kind = kind,
        title = title,
        sourceUri = sourceUri,
        sourceApp = sourceApp,
        sourceLabel = sourceLabel,
        originalText = originalText,
        bodyRef = bodyRef,
        previewRef = previewRef,
        mimeType = mimeType,
        byteCount = byteCount,
        contentDigest = contentDigest,
        summary = summary,
        annotation = annotation,
        tags = runCatching { json.decodeFromString<List<String>>(tagsJson) }.getOrDefault(emptyList()),
        collectionIds = runCatching { json.decodeFromString<List<String>>(collectionIdsJson) }.getOrDefault(emptyList()),
        pinned = pinned,
        archived = archived,
        readingState = readingState,
        readingProgress = readingProgress,
        createdAt = Instant.ofEpochMilli(createdAt).toString(),
        updatedAt = Instant.ofEpochMilli(updatedAt).toString(),
        lastOpenedAt = lastOpenedAt?.let { Instant.ofEpochMilli(it).toString() },
        processingState = processingState,
        processingErrorCode = processingErrorCode,
        syncState = syncState,
        originDeviceId = originDeviceId,
        deletedAt = deletedAt?.let { Instant.ofEpochMilli(it).toString() },
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
        return record.toEntity(normalizedUrl, record.contentDigest?.lowercase(Locale.ROOT))
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
            val scheme = uri.scheme?.lowercase(Locale.ROOT) ?: return null
            val host = uri.host?.lowercase(Locale.ROOT) ?: return null
            if (scheme !in setOf("http", "https") || uri.userInfo != null) return null
            val port = when {
                scheme == "http" && uri.port == 80 -> -1
                scheme == "https" && uri.port == 443 -> -1
                else -> uri.port
            }
            val query = uri.rawQuery?.split('&')?.mapNotNull { part ->
                val name = part.substringBefore('=').lowercase(Locale.ROOT)
                part.takeUnless { name.startsWith("utm_") || name in TRACKING_KEYS }
            }?.sorted()?.joinToString("&")?.ifBlank { null }
            URI(scheme, null, host, port, uri.rawPath.ifBlank { "/" }, query, null).toASCIIString()
        }.getOrNull()

        fun isSafeRelativeRef(value: String?): Boolean {
            if (value == null) return true
            if (value.isBlank() || value.startsWith('/') || value.startsWith('\\') ||
                value.contains('\u0000') || Regex("^[A-Za-z]:[\\\\/]").containsMatchIn(value)) return false
            return value.split('/', '\\').none { it.isBlank() || it == "." || it == ".." }
        }

        fun normalizedTags(tags: List<String>): List<String> {
            val seen = mutableSetOf<String>()
            return tags.map(String::trim).filter { it.isNotEmpty() && seen.add(it.lowercase(Locale.ROOT)) }
        }

        fun normalizedCollectionIds(ids: List<String>): List<String> {
            val seen = mutableSetOf<String>()
            return ids.map { it.trim().take(200) }
                .filter { it.isNotEmpty() && seen.add(it.lowercase(Locale.ROOT)) }
                .take(100)
        }

        private fun escapeLike(value: String): String = value
            .replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

        fun ftsExpression(raw: String): String = raw.trim().take(512)
            .split(Regex("\\s+"))
            .map { it.replace("\"", "\"\"") }
            .filter(String::isNotEmpty)
            .joinToString(" AND ") { "\"$it\"*" }

        private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}
