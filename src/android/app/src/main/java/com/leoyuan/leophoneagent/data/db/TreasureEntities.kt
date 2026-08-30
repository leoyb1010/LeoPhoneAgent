package com.leoyuan.leophoneagent.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(
    tableName = "treasure_items",
    indices = [
        Index(value = ["stable_id"], unique = true),
        Index(value = ["deleted_at", "updated_at"]),
        Index(value = ["normalized_url_key"]),
        Index(value = ["content_digest"]),
    ],
)
data class TreasureItemEntity(
    @PrimaryKey(autoGenerate = true) @ColumnInfo(name = "row_id") val rowId: Long = 0,
    @ColumnInfo(name = "stable_id") val id: String,
    @ColumnInfo(name = "schema_version") val schemaVersion: Int = 1,
    val kind: String,
    val title: String? = null,
    @ColumnInfo(name = "source_uri") val sourceUri: String? = null,
    @ColumnInfo(name = "normalized_url_key") val normalizedUrlKey: String? = null,
    @ColumnInfo(name = "source_app") val sourceApp: String? = null,
    @ColumnInfo(name = "source_label") val sourceLabel: String,
    @ColumnInfo(name = "original_text") val originalText: String? = null,
    @ColumnInfo(name = "body_ref") val bodyRef: String? = null,
    @ColumnInfo(name = "preview_ref") val previewRef: String? = null,
    @ColumnInfo(name = "mime_type") val mimeType: String? = null,
    @ColumnInfo(name = "byte_count") val byteCount: Long = 0,
    @ColumnInfo(name = "content_digest") val contentDigest: String? = null,
    val summary: String? = null,
    val annotation: String? = null,
    @ColumnInfo(name = "tags_json") val tagsJson: String = "[]",
    @ColumnInfo(name = "collection_ids_json") val collectionIdsJson: String = "[]",
    val pinned: Boolean = false,
    val archived: Boolean = false,
    @ColumnInfo(name = "reading_state") val readingState: String = "none",
    @ColumnInfo(name = "reading_progress") val readingProgress: Double = 0.0,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    @ColumnInfo(name = "last_opened_at") val lastOpenedAt: Long? = null,
    @ColumnInfo(name = "processing_state") val processingState: String = "saved",
    @ColumnInfo(name = "processing_error_code") val processingErrorCode: String? = null,
    @ColumnInfo(name = "sync_state") val syncState: String = "local",
    @ColumnInfo(name = "origin_device_id") val originDeviceId: String,
    @ColumnInfo(name = "deleted_at") val deletedAt: Long? = null,
)

/** Lightweight list/search projection; never carries a full body or attachment bytes. */
data class TreasureSearchRow(
    @ColumnInfo(name = "stable_id") val id: String,
    val kind: String,
    val title: String?,
    @ColumnInfo(name = "source_uri") val sourceUri: String?,
    @ColumnInfo(name = "source_label") val sourceLabel: String,
    val snippet: String,
    @ColumnInfo(name = "match_offsets") val matchOffsets: String,
    @ColumnInfo(name = "tags_json") val tagsJson: String,
    val pinned: Boolean,
    val archived: Boolean,
    @ColumnInfo(name = "processing_state") val processingState: String,
    @ColumnInfo(name = "processing_error_code") val processingErrorCode: String?,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

@Entity(tableName = "treasure_collections")
data class TreasureCollectionEntity(
    @PrimaryKey val id: String,
    val name: String,
    val icon: String? = null,
    @ColumnInfo(name = "color_token") val colorToken: String? = null,
    @ColumnInfo(name = "sort_order") val sortOrder: Int = 0,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    @ColumnInfo(name = "deleted_at") val deletedAt: Long? = null,
)

@Entity(
    tableName = "treasure_chunks",
    primaryKeys = ["item_id", "chunk_index"],
    foreignKeys = [ForeignKey(
        entity = TreasureItemEntity::class,
        parentColumns = ["stable_id"], childColumns = ["item_id"],
        onDelete = ForeignKey.CASCADE,
    )],
    indices = [Index("item_id")],
)
data class TreasureChunkEntity(
    @ColumnInfo(name = "item_id") val itemId: String,
    @ColumnInfo(name = "chunk_index") val chunkIndex: Int,
    @ColumnInfo(name = "section_label") val sectionLabel: String? = null,
    val text: String,
    @ColumnInfo(name = "start_offset") val startOffset: Int,
    @ColumnInfo(name = "end_offset") val endOffset: Int,
)

@Entity(
    tableName = "treasure_jobs",
    foreignKeys = [ForeignKey(
        entity = TreasureItemEntity::class,
        parentColumns = ["stable_id"], childColumns = ["item_id"],
        onDelete = ForeignKey.CASCADE,
    )],
    indices = [Index("item_id"), Index(value = ["state", "next_attempt_at", "created_at"])],
)
data class TreasureJobEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "item_id") val itemId: String,
    @ColumnInfo(name = "job_type") val jobType: String,
    val state: String = "queued",
    @ColumnInfo(name = "attempt_count") val attemptCount: Int = 0,
    @ColumnInfo(name = "next_attempt_at") val nextAttemptAt: Long? = null,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    @ColumnInfo(name = "last_error_code") val lastErrorCode: String? = null,
)

@Entity(
    tableName = "treasure_changes",
    indices = [Index("item_id"), Index("change_id", unique = true)],
)
data class TreasureChangeEntity(
    @PrimaryKey(autoGenerate = true) @ColumnInfo(name = "sequence") val sequence: Long = 0,
    @ColumnInfo(name = "change_id") val changeId: String,
    @ColumnInfo(name = "item_id") val itemId: String,
    val operation: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    @ColumnInfo(name = "origin_device_id") val originDeviceId: String,
    @ColumnInfo(name = "payload_digest") val payloadDigest: String,
)
