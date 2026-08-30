package com.leoyuan.leophoneagent.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.RawQuery
import androidx.room.Transaction
import androidx.room.Update
import androidx.sqlite.db.SupportSQLiteQuery
import kotlinx.coroutines.flow.Flow

data class TreasureCaptureBundle(
    val item: TreasureItemEntity,
    val jobs: List<TreasureJobEntity>,
    val change: TreasureChangeEntity,
)

internal fun mergeRemoteTreasureItem(
    existing: TreasureItemEntity,
    incoming: TreasureItemEntity,
    preserveLocalAssets: Boolean,
    conflict: Boolean,
): TreasureItemEntity = incoming.copy(
    rowId = existing.rowId,
    originalText = incoming.originalText ?: existing.originalText.takeIf { preserveLocalAssets },
    bodyRef = incoming.bodyRef ?: existing.bodyRef.takeIf { preserveLocalAssets },
    previewRef = incoming.previewRef ?: existing.previewRef,
    mimeType = incoming.mimeType ?: existing.mimeType.takeIf { preserveLocalAssets },
    byteCount = if (preserveLocalAssets) maxOf(incoming.byteCount, existing.byteCount)
        else incoming.byteCount,
    contentDigest = incoming.contentDigest ?: existing.contentDigest.takeIf { preserveLocalAssets },
    syncState = if (conflict) "conflict" else "synced",
)

@Dao
interface TreasureDao {
    @Query("SELECT * FROM treasure_items WHERE deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC LIMIT :limit OFFSET :offset")
    fun observeItems(limit: Int, offset: Int): Flow<List<TreasureItemEntity>>

    @Query("""
        SELECT stable_id, kind, title, source_uri, source_label,
               substr(COALESCE(NULLIF(summary, ''), NULLIF(original_text, ''), source_uri, processing_error_code, ''), 1, 400) AS snippet,
               '' AS match_offsets, tags_json, pinned, archived, reading_state, reading_progress,
               last_opened_at, processing_state, processing_error_code, created_at, updated_at
        FROM treasure_items
        WHERE deleted_at IS NULL
        ORDER BY pinned DESC, updated_at DESC
        LIMIT :limit OFFSET :offset
    """)
    fun observeSearchRows(limit: Int, offset: Int): Flow<List<TreasureSearchRow>>

    @Query("SELECT * FROM treasure_items WHERE stable_id IN (:ids) AND deleted_at IS NULL")
    suspend fun getByIds(ids: List<String>): List<TreasureItemEntity>

    @Query("SELECT * FROM treasure_items WHERE stable_id = :id LIMIT 1")
    suspend fun getIncludingDeleted(id: String): TreasureItemEntity?

    @Query("SELECT * FROM treasure_items WHERE stable_id IN (:ids)")
    suspend fun getManyIncludingDeleted(ids: List<String>): List<TreasureItemEntity>

    @Query("SELECT * FROM treasure_items WHERE stable_id = :id AND deleted_at IS NULL LIMIT 1")
    suspend fun getById(id: String): TreasureItemEntity?

    @Query("""
        UPDATE treasure_items SET original_text = :body
        WHERE stable_id = :id AND deleted_at IS NULL
          AND origin_device_id != :localOriginDeviceId
          AND sync_state IN ('remote_only','synced','conflict')
    """)
    suspend fun cacheRemoteBody(id: String, localOriginDeviceId: String, body: String): Int

    @Query("""
        UPDATE treasure_items
        SET body_ref = :bodyRef, mime_type = :mimeType,
            byte_count = :byteCount, content_digest = :digest
        WHERE stable_id = :id AND deleted_at IS NULL
          AND kind IN ('image','document','audio','video','artifact')
          AND origin_device_id != :localOriginDeviceId
          AND sync_state IN ('remote_only','synced','conflict')
    """)
    suspend fun cacheRemoteAttachment(
        id: String,
        localOriginDeviceId: String,
        bodyRef: String,
        mimeType: String,
        byteCount: Long,
        digest: String,
    ): Int

    @Query("SELECT * FROM treasure_highlights WHERE item_id = :itemId AND deleted_at IS NULL ORDER BY page_number, start_offset, created_at")
    fun observeHighlights(itemId: String): Flow<List<TreasureHighlightEntity>>

    @Query("SELECT * FROM treasure_highlights WHERE id = :id AND deleted_at IS NULL LIMIT 1")
    suspend fun getHighlight(id: String): TreasureHighlightEntity?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertHighlight(highlight: TreasureHighlightEntity)

    @Query("UPDATE treasure_highlights SET deleted_at = :now, updated_at = :now WHERE id = :id AND deleted_at IS NULL")
    suspend fun softDeleteHighlight(id: String, now: Long): Int

    @Query("UPDATE treasure_items SET updated_at = :now, sync_state = 'pending' WHERE stable_id = :itemId AND deleted_at IS NULL")
    suspend fun touchItem(itemId: String, now: Long): Int

    @Query("SELECT * FROM treasure_items WHERE normalized_url_key = :key AND deleted_at IS NULL LIMIT 1")
    suspend fun findByNormalizedUrl(key: String): TreasureItemEntity?

    @Query("SELECT * FROM treasure_items WHERE content_digest = :digest AND deleted_at IS NULL LIMIT 1")
    suspend fun findByDigest(digest: String): TreasureItemEntity?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertItem(item: TreasureItemEntity): Long

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertRemoteItem(item: TreasureItemEntity): Long

    @Update
    suspend fun updateItem(item: TreasureItemEntity)

    @Transaction
    suspend fun applyRemoteItem(
        incoming: TreasureItemEntity,
        operation: String,
        incomingChangeId: String,
        localOriginDeviceId: String,
    ): Boolean {
        val existing = getIncludingDeleted(incoming.id)
        val incomingDeleted = operation == "delete" || incoming.deletedAt != null
        if (existing != null) {
            val incomingKey = listOf(
                incoming.updatedAt.toString().padStart(20, '0'),
                if (incomingDeleted) "1" else "0",
                incoming.originDeviceId,
                incomingChangeId,
            ).joinToString("|")
            val existingKey = listOf(
                existing.updatedAt.toString().padStart(20, '0'),
                if (existing.deletedAt != null) "1" else "0",
                existing.originDeviceId,
                "",
            ).joinToString("|")
            if (incomingKey <= existingKey) {
                if (existing.syncState == "pending" && existing.originDeviceId == localOriginDeviceId &&
                    incoming.updatedAt >= existing.updatedAt) {
                    updateItem(existing.copy(syncState = "conflict"))
                }
                return false
            }
            val conflict = existing.syncState == "pending" && existing.originDeviceId == localOriginDeviceId &&
                incoming.originDeviceId != localOriginDeviceId
            val preserveLocalAssets = existing.originDeviceId == localOriginDeviceId ||
                existing.syncState in setOf("local", "pending", "conflict")
            // Remote body/attachment bytes are caches. A newer remote metadata
            // change invalidates them instead of preserving stale byte counts.
            updateItem(mergeRemoteTreasureItem(
                existing = existing,
                incoming = incoming,
                preserveLocalAssets = preserveLocalAssets,
                conflict = conflict,
            ))
            return true
        }
        return insertRemoteItem(incoming.copy(syncState = "remote_only")) != -1L
    }

    @Query("UPDATE treasure_items SET deleted_at = :deletedAt, updated_at = :deletedAt, sync_state = 'pending' WHERE stable_id IN (:ids) AND deleted_at IS NULL")
    suspend fun tombstone(ids: List<String>, deletedAt: Long): Int

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertJobs(jobs: List<TreasureJobEntity>)

    @Query("SELECT * FROM treasure_jobs WHERE state IN ('queued','failed') AND attempt_count < 5 AND (next_attempt_at IS NULL OR next_attempt_at <= :now) ORDER BY CASE WHEN job_type = 'index' THEN 1 ELSE 0 END, created_at LIMIT :limit")
    suspend fun readyJobs(now: Long, limit: Int): List<TreasureJobEntity>

    @Query("SELECT COUNT(*) FROM treasure_jobs WHERE state IN ('queued','failed') AND attempt_count < 5")
    suspend fun pendingAutomaticJobCount(): Int

    @Query("SELECT * FROM treasure_jobs WHERE id = :id LIMIT 1")
    suspend fun getJob(id: String): TreasureJobEntity?

    @Query("UPDATE treasure_jobs SET state = 'processing', attempt_count = attempt_count + 1, next_attempt_at = NULL, updated_at = :now, last_error_code = NULL WHERE id = :id AND state IN ('queued','failed')")
    suspend fun claimJob(id: String, now: Long): Int

    @Query("UPDATE treasure_jobs SET state = 'completed', next_attempt_at = NULL, updated_at = :now, last_error_code = NULL WHERE id = :id")
    suspend fun completeJob(id: String, now: Long): Int

    @Query("UPDATE treasure_jobs SET state = 'failed', next_attempt_at = :nextAttemptAt, updated_at = :now, last_error_code = :errorCode WHERE id = :id")
    suspend fun failJob(id: String, now: Long, nextAttemptAt: Long, errorCode: String): Int

    @Query("UPDATE treasure_jobs SET state = 'failed', next_attempt_at = :now, updated_at = :now, last_error_code = 'process_interrupted' WHERE state = 'processing' AND updated_at < :staleBefore")
    suspend fun recoverStaleJobs(staleBefore: Long, now: Long): Int

    @Query("SELECT DISTINCT item_id FROM treasure_jobs WHERE state = 'processing' AND updated_at < :staleBefore")
    suspend fun staleProcessingItemIds(staleBefore: Long): List<String>

    @Query("UPDATE treasure_jobs SET state = 'queued', attempt_count = 0, next_attempt_at = NULL, updated_at = :now, last_error_code = NULL WHERE item_id = :itemId AND state = 'failed'")
    suspend fun retryFailedJobsRaw(itemId: String, now: Long): Int

    @Query("UPDATE treasure_items SET processing_state = :state, processing_error_code = :errorCode, updated_at = :now, sync_state = 'pending' WHERE stable_id = :itemId AND deleted_at IS NULL")
    suspend fun updateProcessingStateRaw(itemId: String, state: String, errorCode: String?, now: Long): Int

    @Query("UPDATE treasure_items SET processing_state = 'ready', processing_error_code = NULL, updated_at = :now, sync_state = 'pending' WHERE stable_id = :itemId AND deleted_at IS NULL AND processing_state NOT IN ('ready','partial','failed')")
    suspend fun markIndexedRaw(itemId: String, now: Long): Int

    @Query("UPDATE treasure_items SET title = CASE WHEN :title IS NULL THEN title WHEN title IS NULL OR title = :capturedTitle THEN :title ELSE title END, original_text = COALESCE(:originalText, original_text), processing_state = :state, processing_error_code = NULL, updated_at = :now, sync_state = 'pending' WHERE stable_id = :itemId AND deleted_at IS NULL")
    suspend fun applyEnhancementRaw(itemId: String, title: String?, capturedTitle: String?, originalText: String?, state: String, now: Long): Int

    @Query("DELETE FROM treasure_chunks WHERE item_id = :itemId")
    suspend fun deleteChunks(itemId: String)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertChunks(chunks: List<TreasureChunkEntity>)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertChange(change: TreasureChangeEntity)

    @Transaction
    suspend fun addHighlight(highlight: TreasureHighlightEntity, change: TreasureChangeEntity): Boolean {
        val touched = touchItem(highlight.itemId, highlight.updatedAt)
        if (touched <= 0) return false
        insertHighlight(highlight)
        insertChange(change)
        return true
    }

    @Transaction
    suspend fun deleteHighlight(id: String, itemId: String, now: Long, change: TreasureChangeEntity): Boolean {
        val deleted = softDeleteHighlight(id, now)
        if (deleted > 0 && touchItem(itemId, now) > 0) insertChange(change)
        return deleted > 0
    }

    @Transaction
    suspend fun updateProcessingState(
        itemId: String,
        state: String,
        errorCode: String?,
        now: Long,
        change: TreasureChangeEntity,
    ): Int {
        val count = updateProcessingStateRaw(itemId, state, errorCode, now)
        if (count > 0) insertChange(change)
        return count
    }

    @Transaction
    suspend fun markIndexed(itemId: String, now: Long, change: TreasureChangeEntity): Int {
        val count = markIndexedRaw(itemId, now)
        if (count > 0) insertChange(change)
        return count
    }

    @Transaction
    suspend fun applyEnhancement(
        itemId: String,
        title: String?,
        capturedTitle: String?,
        originalText: String?,
        state: String,
        now: Long,
        change: TreasureChangeEntity,
    ): Int {
        val count = applyEnhancementRaw(itemId, title, capturedTitle, originalText, state, now)
        if (count > 0) insertChange(change)
        return count
    }

    @Transaction
    suspend fun retryFailedJobs(
        itemId: String,
        now: Long,
        change: TreasureChangeEntity,
    ): Int {
        val count = retryFailedJobsRaw(itemId, now)
        if (count > 0 && updateProcessingStateRaw(itemId, "queued", null, now) > 0) {
            insertChange(change)
        }
        return count
    }

    @Transaction
    suspend fun applyDocumentExtraction(
        itemId: String,
        originalText: String,
        chunks: List<TreasureChunkEntity>,
        now: Long,
        change: TreasureChangeEntity,
    ): Int {
        val count = applyEnhancementRaw(itemId, null, null, originalText, "ready", now)
        if (count > 0) {
            deleteChunks(itemId)
            insertChunks(chunks)
            insertChange(change)
        }
        return count
    }

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertChanges(changes: List<TreasureChangeEntity>)

    @Transaction
    suspend fun insertCaptured(
        item: TreasureItemEntity,
        jobs: List<TreasureJobEntity>,
        change: TreasureChangeEntity,
    ): TreasureItemEntity {
        getIncludingDeleted(item.id)?.let { return it }
        item.normalizedUrlKey?.let { findByNormalizedUrl(it) }?.let { return it }
        item.contentDigest?.let { findByDigest(it) }?.let { return it }
        val rowId = insertItem(item)
        insertJobs(jobs)
        insertChange(change)
        return item.copy(rowId = rowId)
    }

    @Transaction
    suspend fun insertCapturedBatch(bundles: List<TreasureCaptureBundle>): Int {
        var insertedCount = 0
        for (bundle in bundles) {
            if (getIncludingDeleted(bundle.item.id) != null) continue
            if (bundle.item.normalizedUrlKey?.let { findByNormalizedUrl(it) } != null) continue
            if (bundle.item.contentDigest?.let { findByDigest(it) } != null) continue
            insertItem(bundle.item)
            insertJobs(bundle.jobs)
            insertChange(bundle.change)
            insertedCount += 1
        }
        return insertedCount
    }

    @Transaction
    suspend fun updateWithChange(item: TreasureItemEntity, change: TreasureChangeEntity): Boolean {
        val sameUrl = item.normalizedUrlKey?.let { findByNormalizedUrl(it) }
        if (sameUrl != null && sameUrl.id != item.id) return false
        val sameDigest = item.contentDigest?.let { findByDigest(it) }
        if (sameDigest != null && sameDigest.id != item.id) return false
        updateItem(item)
        insertChange(change)
        return true
    }

    @Transaction
    suspend fun tombstoneWithChanges(
        ids: List<String>,
        deletedAt: Long,
        changes: List<TreasureChangeEntity>,
    ): Int {
        val count = tombstone(ids, deletedAt)
        insertChanges(changes)
        return count
    }

    @Query("SELECT * FROM treasure_changes WHERE sequence > :after ORDER BY sequence LIMIT :limit")
    suspend fun changes(after: Long, limit: Int): List<TreasureChangeEntity>

    @RawQuery(observedEntities = [TreasureItemEntity::class])
    fun search(query: SupportSQLiteQuery): Flow<List<TreasureItemEntity>>

    @RawQuery(observedEntities = [TreasureItemEntity::class])
    fun searchRows(query: SupportSQLiteQuery): Flow<List<TreasureSearchRow>>

    @RawQuery
    suspend fun mutateSearchIndex(query: SupportSQLiteQuery): Int

    @Transaction
    suspend fun rebuildSearchIndex() {
        mutateSearchIndex(androidx.sqlite.db.SimpleSQLiteQuery("DELETE FROM treasure_search_fts"))
        mutateSearchIndex(androidx.sqlite.db.SimpleSQLiteQuery(
            "INSERT INTO treasure_search_fts(rowid, stable_id, title, original_text, summary, annotation, tags_json) " +
                "SELECT row_id, stable_id, COALESCE(title,''), COALESCE(original_text,''), " +
                "COALESCE(summary,''), COALESCE(annotation,''), tags_json " +
                "FROM treasure_items WHERE deleted_at IS NULL"
        ))
    }
}
