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

@Dao
interface TreasureDao {
    @Query("SELECT * FROM treasure_items WHERE deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC LIMIT :limit OFFSET :offset")
    fun observeItems(limit: Int, offset: Int): Flow<List<TreasureItemEntity>>

    @Query("SELECT * FROM treasure_items WHERE stable_id IN (:ids) AND deleted_at IS NULL")
    suspend fun getByIds(ids: List<String>): List<TreasureItemEntity>

    @Query("SELECT * FROM treasure_items WHERE stable_id = :id LIMIT 1")
    suspend fun getIncludingDeleted(id: String): TreasureItemEntity?

    @Query("SELECT * FROM treasure_items WHERE normalized_url_key = :key AND deleted_at IS NULL LIMIT 1")
    suspend fun findByNormalizedUrl(key: String): TreasureItemEntity?

    @Query("SELECT * FROM treasure_items WHERE content_digest = :digest AND deleted_at IS NULL LIMIT 1")
    suspend fun findByDigest(digest: String): TreasureItemEntity?

    @Insert(onConflict = OnConflictStrategy.ABORT)
    suspend fun insertItem(item: TreasureItemEntity): Long

    @Update
    suspend fun updateItem(item: TreasureItemEntity)

    @Query("UPDATE treasure_items SET deleted_at = :deletedAt, updated_at = :deletedAt, sync_state = 'pending' WHERE stable_id IN (:ids) AND deleted_at IS NULL")
    suspend fun tombstone(ids: List<String>, deletedAt: Long): Int

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertJobs(jobs: List<TreasureJobEntity>)

    @Query("SELECT * FROM treasure_jobs WHERE state IN ('queued','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= :now) ORDER BY created_at LIMIT :limit")
    suspend fun readyJobs(now: Long, limit: Int): List<TreasureJobEntity>

    @Query("SELECT * FROM treasure_jobs WHERE id = :id LIMIT 1")
    suspend fun getJob(id: String): TreasureJobEntity?

    @Query("UPDATE treasure_jobs SET state = 'processing', attempt_count = attempt_count + 1, next_attempt_at = NULL, updated_at = :now, last_error_code = NULL WHERE id = :id AND state IN ('queued','failed')")
    suspend fun claimJob(id: String, now: Long): Int

    @Query("UPDATE treasure_jobs SET state = 'completed', next_attempt_at = NULL, updated_at = :now, last_error_code = NULL WHERE id = :id")
    suspend fun completeJob(id: String, now: Long): Int

    @Query("UPDATE treasure_jobs SET state = 'failed', next_attempt_at = :nextAttemptAt, updated_at = :now, last_error_code = :errorCode WHERE id = :id")
    suspend fun failJob(id: String, now: Long, nextAttemptAt: Long, errorCode: String): Int

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertChange(change: TreasureChangeEntity)

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
