package com.leoyuan.leophoneagent.treasury

import android.content.Context
import com.leoyuan.leophoneagent.data.repository.TreasureItemRecord
import com.leoyuan.leophoneagent.data.repository.TreasureRemoteChange
import com.leoyuan.leophoneagent.data.repository.TreasureRepository
import com.leoyuan.leophoneagent.data.db.TreasureItemEntity
import com.leoyuan.leophoneagent.relay.RelayFleetStore
import java.io.ByteArrayOutputStream
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.time.Instant
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody

internal class TreasurySyncClient(
    context: Context,
    private val http: OkHttpClient = SHARED_HTTP,
) {
    private val app = context.applicationContext
    private val state = app.getSharedPreferences("treasury_sync_state", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun sync(repository: TreasureRepository): Boolean = withContext(Dispatchers.IO) {
        val config = RelayFleetStore.get(app).config.value
        val base = config.relayApiBase.trimEnd('/')
        val key = config.accessKey.trim().trimEnd('%').trim()
        if (key.length < 16) return@withContext true
        runCatching {
            val scope = sha256(base).take(24)
            upload(repository, base, key, scope)
            pull(repository, base, key, scope)
            serveAssetRequests(repository, base, key)
            true
        }.getOrElse {
            // Same reason as fetchAsset: runCatching also catches cancellation,
            // and reporting it as a plain failed sync hides that the caller gave
            // up while the remaining stages keep issuing network and DB work.
            if (it is CancellationException) throw it
            false
        }
    }

    suspend fun fetchAsset(
        repository: TreasureRepository,
        itemId: String,
        kind: String,
    ): TreasuryAssetFetchResult = withContext(Dispatchers.IO) {
        if (kind !in setOf("body", "attachment")) return@withContext TreasuryAssetFetchResult("unavailable")
        val item = repository.get(listOf(itemId)).firstOrNull()
            ?: return@withContext TreasuryAssetFetchResult("unavailable")
        if (item.originDeviceId == repository.localOriginDeviceId()) {
            return@withContext TreasuryAssetFetchResult("unavailable", item)
        }
        val config = RelayFleetStore.get(app).config.value
        val base = config.relayApiBase.trimEnd('/')
        val key = config.accessKey.trim().trimEnd('%').trim()
        if (key.length < 16) return@withContext TreasuryAssetFetchResult("unavailable", item)
        runCatching {
            val created = request(
                base, key, "treasury/assets/requests", "POST",
                buildJsonObject {
                    put("item_id", itemId)
                    put("asset_kind", kind)
                    put("requester_device_id", repository.localOriginDeviceId())
                },
            )
            if (created.code in setOf(404, 409)) return@runCatching TreasuryAssetFetchResult("unavailable", item)
            if (created.code !in 200..299) error("relay treasury asset request failed")
            val raw = created.body?.get("request") as? JsonObject
                ?: error("relay treasury asset request missing")
            val requestId = raw.text("id", 200)?.takeIf {
                runCatching { java.util.UUID.fromString(it) }.isSuccess
            } ?: error("relay treasury asset request invalid")
            if (raw.text("item_id", 200) != itemId || raw.text("asset_kind", 20) != kind) {
                error("relay treasury asset request mismatch")
            }
            when (raw.text("status", 20)) {
                "pending" -> TreasuryAssetFetchResult("pending", item)
                "ready" -> downloadAsset(repository, item, kind, requestId, base, key)
                else -> TreasuryAssetFetchResult("unavailable", item)
            }
        }.getOrElse {
            // runCatching also catches cancellation; swallowing it would let the
            // HTTP call and DB write run on after the caller gave up.
            if (it is CancellationException) throw it
            TreasuryAssetFetchResult("failed", item)
        }
    }

    private suspend fun downloadAsset(
        repository: TreasureRepository,
        item: TreasureItemEntity,
        kind: String,
        requestId: String,
        base: String,
        key: String,
    ): TreasuryAssetFetchResult {
        val partial = if (kind == "attachment") repository.remoteAssetPartialFile(item.id, kind) else null
        var offset = partial?.let { repository.remoteAssetPartialLength(it, ATTACHMENT_LIMIT) } ?: 0L
        if (item.byteCount > 0 && offset >= item.byteCount) {
            partial?.delete()
            offset = 0
        }
        fun buildDownload(start: Long): Request = Request.Builder()
            .url("$base/treasury/assets/$requestId")
            .header("Authorization", "Bearer $key")
            .header("X-Treasury-Device-ID", repository.localOriginDeviceId())
            .apply { if (start > 0) header("Range", "bytes=$start-") }
            .build()

        var response = http.newCall(buildDownload(offset)).execute()
        if (treasuryRangeAction(response.code, offset) == TreasuryRangeAction.RETRY) {
            response.close()
            partial?.delete()
            offset = 0
            response = http.newCall(buildDownload(0)).execute()
        }
        response.use { result ->
            if (result.code == 202) return TreasuryAssetFetchResult("pending", item)
            if (result.code == 410) return TreasuryAssetFetchResult("unavailable", item)
            if (!result.isSuccessful) error("relay treasury asset download failed")
            val metadata = safeAssetHeaders(result, if (kind == "body") BODY_LIMIT else ATTACHMENT_LIMIT)
            if (kind == "body") {
                if (result.code == 206 || metadata.mimeType != "text/plain") {
                    error("relay treasury body response invalid")
                }
                // Read through the declared count instead of buffering the whole
                // response first: a lying relay must not OOM the app before the check.
                val input = result.body?.byteStream() ?: error("relay treasury body missing")
                val collected = ByteArrayOutputStream()
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                var received = 0L
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    received += read
                    if (received > metadata.byteCount || received > BODY_LIMIT) {
                        error("relay treasury body exceeds declared size")
                    }
                    collected.write(buffer, 0, read)
                }
                val bytes = collected.toByteArray()
                if (bytes.size.toLong() != metadata.byteCount || sha256(bytes) != metadata.digest) {
                    error("relay treasury body integrity mismatch")
                }
                val text = Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString()
                val cached = repository.cacheRemoteBody(item.id, text, metadata.digest, metadata.byteCount)
                    ?: error("remote treasury body cache failed")
                return TreasuryAssetFetchResult("ready", cached)
            }

            if (item.byteCount > 0 && item.byteCount != metadata.byteCount ||
                item.contentDigest != null && !item.contentDigest.equals(metadata.digest, ignoreCase = true) ||
                item.mimeType != null && item.mimeType.substringBefore(';').lowercase() != metadata.mimeType) {
                partial?.delete()
                error("remote treasury attachment metadata mismatch")
            }
            when (treasuryRangeAction(
                result.code, offset, result.header("Content-Range"), metadata.byteCount,
            )) {
                TreasuryRangeAction.CONTINUE -> Unit
                TreasuryRangeAction.TRUNCATE -> {
                    partial?.delete()
                    offset = 0
                }
                TreasuryRangeAction.RETRY, TreasuryRangeAction.REJECT -> {
                    if (offset > 0 && result.code == 206) partial?.delete()
                    error("relay treasury attachment range response invalid")
                }
            }
            val target = partial ?: error("remote treasury attachment cache missing")
            val digest = MessageDigest.getInstance("SHA-256")
            if (offset > 0) FileInputStream(target).buffered().use { input ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                }
            }
            var count = offset
            var discardPartial = false
            TreasuryStoragePolicy.whileDownloading {
                try {
                    FileOutputStream(target, offset > 0).use { output ->
                        val input = result.body?.byteStream() ?: error("relay treasury attachment missing")
                        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            count += read
                            if (count > metadata.byteCount || count > ATTACHMENT_LIMIT) {
                                discardPartial = true
                                error("remote treasury attachment exceeds declared size")
                            }
                            digest.update(buffer, 0, read)
                            output.write(buffer, 0, read)
                        }
                        output.flush()
                        output.fd.sync()
                    }
                    // A 206 may legally stop short of total-1. The retained prefix is
                    // correct, so keep it and resume from it instead of starting over.
                    if (count < metadata.byteCount) error("remote treasury attachment incomplete")
                    if (digest.digest().toHex() != metadata.digest) {
                        discardPartial = true
                        error("remote treasury attachment integrity mismatch")
                    }
                } catch (error: Throwable) {
                    if (discardPartial) target.delete()
                    throw error
                }
            }
            val cached = repository.cacheRemoteAttachment(
                item.id, target, metadata.mimeType, metadata.byteCount, metadata.digest,
            ) ?: error("remote treasury attachment cache failed")
            return TreasuryAssetFetchResult("ready", cached)
        }
    }

    private data class AssetHeaders(val digest: String, val byteCount: Long, val mimeType: String)

    private fun safeAssetHeaders(response: okhttp3.Response, limit: Long): AssetHeaders {
        val digest = response.header("X-Treasury-Digest").orEmpty().lowercase()
        val count = response.header("X-Treasury-Byte-Count")?.toLongOrNull() ?: -1
        val mime = response.header("Content-Type").orEmpty().substringBefore(';').trim().lowercase()
        require(DIGEST.matches(digest) && count in 0L..limit && mime in ALLOWED_ASSET_MIMES) {
            "relay treasury asset metadata invalid"
        }
        return AssetHeaders(digest, count, mime)
    }

    private suspend fun upload(repository: TreasureRepository, base: String, key: String, scope: String) {
        var cursor = state.getLong("upload.$scope", 0)
        val deviceId = repository.localOriginDeviceId()
        repeat(20) {
            val changes = repository.changes(cursor, 500)
            if (changes.isEmpty()) return
            val records = repository.recordsIncludingDeleted(changes.map { it.itemId })
            val payload = buildJsonObject {
                put("device_id", deviceId)
                put("changes", buildJsonArray {
                    changes.forEach { change ->
                        add(buildJsonObject {
                            put("local_sequence", change.sequence)
                            put("change_id", change.changeId)
                            put("item_id", change.itemId)
                            put("operation", change.operation)
                            put("updated_at", change.updatedAt / 1_000.0)
                            put("origin_device_id", deviceId)
                            put("payload_digest", change.payloadDigest)
                            if (change.operation == "upsert") records[change.itemId]?.let { record ->
                                put("item", metadata(record, deviceId))
                            }
                        })
                    }
                })
            }
            val response = request(base, key, "treasury/changes", "POST", payload)
            if (response.code !in 200..299) error("relay treasury upload failed")
            val body = response.body ?: error("relay treasury upload response missing")
            val ack = body["ack_local_cursor"]?.jsonPrimitive?.longOrNull ?: error("relay ack missing")
            if (ack <= cursor) error("relay ack stalled")
            cursor = ack
            state.edit().putLong("upload.$scope", cursor).apply()
            if (changes.size < 500) return
        }
        error("treasury upload page limit exceeded")
    }

    private suspend fun pull(repository: TreasureRepository, base: String, key: String, scope: String) {
        var cursor = state.getLong("download.$scope", 0)
        repeat(40) {
            val response = request(base, key, "treasury/changes?after=$cursor&limit=500")
            if (response.code == 410) {
                rebuild(repository, base, key, scope)
                return
            }
            if (response.code !in 200..299) error("relay treasury download failed")
            val body = response.body ?: error("relay treasury download response missing")
            val rawChanges = body["changes"] as? JsonArray
                ?: error("relay treasury change list missing")
            var deliveredCursor = cursor
            val changes = buildList {
                for (element in rawChanges) {
                    val raw = element as? JsonObject ?: error("relay treasury change invalid")
                    val sequence = (raw["sequence"] as? JsonPrimitive)?.longOrNull
                        ?.takeIf { it > deliveredCursor } ?: error("relay treasury change order invalid")
                    deliveredCursor = sequence
                    val applied = (raw["applied"] as? JsonPrimitive)?.booleanOrNull
                    if (applied == false) continue
                    add(remoteChange(raw) ?: error("relay treasury change invalid"))
                }
            }
            repository.applyRemoteChanges(changes)
            val next = body["next_cursor"]?.jsonPrimitive?.longOrNull ?: cursor
            if (next != deliveredCursor) error("relay cursor does not match delivered changes")
            cursor = next
            state.edit().putLong("download.$scope", cursor).apply()
            if (body["has_more"]?.jsonPrimitive?.booleanOrNull != true) return
        }
        error("treasury download page limit exceeded")
    }

    private suspend fun rebuild(repository: TreasureRepository, base: String, key: String, scope: String) {
        var after = 0L
        var serverCursor = 0L
        val changes = mutableListOf<TreasureRemoteChange>()
        repeat(60) {
            val response = request(base, key, "treasury/items?after_sequence=$after&limit=1000")
            if (response.code !in 200..299) error("relay treasury rebuild failed")
            val body = response.body ?: error("relay treasury rebuild response missing")
            val items = body["items"] as? JsonArray ?: error("relay treasury snapshot missing")
            var pageCursor = after
            items.forEach { element ->
                val raw = element as? JsonObject ?: error("relay treasury snapshot invalid")
                val sequence = raw["server_sequence"]?.jsonPrimitive?.longOrNull
                    ?.takeIf { it > pageCursor } ?: error("relay treasury snapshot order invalid")
                pageCursor = sequence
                val record = remoteRecord(raw) ?: error("relay treasury snapshot invalid")
                val deleted = record.deletedAt != null
                changes += TreasureRemoteChange(
                    sequence = sequence,
                    changeId = "snapshot-$sequence-${record.id}",
                    itemId = record.id,
                    operation = if (deleted) "delete" else "upsert",
                    updatedAt = Instant.parse(record.updatedAt).toEpochMilli(),
                    originDeviceId = record.originDeviceId,
                    payloadDigest = "0".repeat(64),
                    record = record,
                )
            }
            after = body["next_cursor"]?.jsonPrimitive?.longOrNull ?: after
            if (after != pageCursor) error("relay treasury snapshot cursor mismatch")
            serverCursor = body["server_cursor"]?.jsonPrimitive?.longOrNull ?: serverCursor
            if (serverCursor < after) error("relay treasury server cursor invalid")
            if (body["has_more"]?.jsonPrimitive?.booleanOrNull != true) {
                repository.applyRemoteChanges(changes)
                state.edit().putLong("download.$scope", serverCursor).apply()
                return
            }
        }
        error("treasury rebuild page limit exceeded")
    }

    private suspend fun serveAssetRequests(repository: TreasureRepository, base: String, key: String) {
        val deviceId = repository.localOriginDeviceId()
        val encoded = URLEncoder.encode(deviceId, Charsets.UTF_8.name())
        val response = request(base, key, "treasury/assets/requests?origin_device_id=$encoded")
        if (response.code !in 200..299) error("relay treasury asset request failed")
        val requests = response.body?.get("requests")?.jsonArray.orEmpty()
        for (element in requests.take(10)) {
            val raw = element as? JsonObject ?: continue
            val requestId = raw.text("id", 200) ?: continue
            if (runCatching { java.util.UUID.fromString(requestId) }.isFailure) continue
            val itemId = raw.text("item_id", 200) ?: continue
            val kind = raw.text("asset_kind", 20)?.takeIf { it in setOf("body", "attachment") }
                ?: continue
            val asset = repository.syncAsset(itemId, kind)
            if (asset == null) {
                request(
                    base, key, "treasury/assets/$requestId/unavailable", "POST",
                    buildJsonObject { put("device_id", deviceId) },
                )
                continue
            }
            try {
                val upload = Request.Builder()
                    .url("$base/treasury/assets/$requestId")
                    .header("Authorization", "Bearer $key")
                    .header("X-Treasury-Device-ID", deviceId)
                    .header("X-Treasury-Digest", asset.digest)
                    .header("X-Treasury-Byte-Count", asset.byteCount.toString())
                    .put(asset.file.asRequestBody(asset.mimeType.toMediaType()))
                    .build()
                http.newCall(upload).execute().use { result ->
                    if (!result.isSuccessful) error("relay treasury asset upload failed")
                }
            } finally {
                if (asset.removeAfterUpload) asset.file.delete()
            }
        }
    }

    private data class Response(val code: Int, val body: JsonObject?)

    private fun request(
        base: String,
        key: String,
        relative: String,
        method: String = "GET",
        body: JsonObject? = null,
    ): Response {
        val builder = Request.Builder()
            .url("$base/$relative")
            .header("Authorization", "Bearer $key")
        if (method == "POST") {
            builder.post(json.encodeToString(JsonObject.serializer(), body ?: JsonObject(emptyMap()))
                .toRequestBody("application/json".toMediaType()))
        }
        http.newCall(builder.build()).execute().use { response ->
            val parsed = response.body?.string()?.takeIf(String::isNotBlank)?.let { raw ->
                runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull()
            }
            return Response(response.code, parsed)
        }
    }

    private fun metadata(record: TreasureItemRecord, deviceId: String): JsonObject = buildJsonObject {
        val availability = treasurySyncAvailability(record)
        put("id", record.id); put("schema_version", 1); put("kind", record.kind)
        put("title", record.title.orEmpty()); put("source_uri", record.sourceUri.orEmpty())
        put("source_app", record.sourceApp.orEmpty()); put("source_label", record.sourceLabel)
        put("summary", record.summary.orEmpty()); put("annotation", record.annotation.orEmpty())
        put("tags", JsonArray(record.tags.map(::JsonPrimitive)))
        put("collection_ids", JsonArray(record.collectionIds.map(::JsonPrimitive)))
        put("pinned", record.pinned); put("archived", record.archived)
        put("reading_state", record.readingState); put("reading_progress", record.readingProgress)
        put("created_at", Instant.parse(record.createdAt).toEpochMilli() / 1_000.0)
        put("updated_at", Instant.parse(record.updatedAt).toEpochMilli() / 1_000.0)
        put("last_opened_at", record.lastOpenedAt?.let { Instant.parse(it).toEpochMilli() / 1_000.0 } ?: 0)
        put("processing_state", record.processingState)
        put("processing_error_code", record.processingErrorCode.orEmpty())
        put("content_digest", record.contentDigest.orEmpty()); put("byte_count", record.byteCount)
        put("mime_type", record.mimeType.orEmpty())
        put("body_available", availability.body)
        put("attachment_available", availability.attachment)
        put("origin_device_id", deviceId)
        put("deleted_at", record.deletedAt?.let { Instant.parse(it).toEpochMilli() / 1_000.0 } ?: 0)
    }

    private fun remoteChange(element: JsonElement): TreasureRemoteChange? {
        val raw = element as? JsonObject ?: return null
        val sequence = raw["sequence"]?.jsonPrimitive?.longOrNull ?: return null
        val changeId = raw.text("change_id", 200) ?: return null
        val itemId = raw.text("item_id", 200) ?: return null
        val operation = raw.text("operation", 20)?.takeIf { it in setOf("upsert", "delete") } ?: return null
        val updated = raw["updated_at"]?.jsonPrimitive?.doubleOrNull?.times(1_000)?.toLong() ?: return null
        val origin = raw.text("origin_device_id", 200) ?: return null
        val digest = raw.text("payload_digest", 64)?.takeIf { DIGEST.matches(it) } ?: return null
        val record = (raw["item"] as? JsonObject)?.let(::remoteRecord)
        if (operation == "upsert" &&
            (record == null || record.id != itemId || record.originDeviceId != origin)) return null
        return TreasureRemoteChange(sequence, changeId, itemId, operation, updated, origin, digest, record)
    }

    private fun remoteRecord(raw: JsonObject): TreasureItemRecord? {
        val id = raw.text("id", 200) ?: return null
        val kind = raw.text("kind", 20)?.takeIf { it in KINDS } ?: return null
        val origin = raw.text("origin_device_id", 200) ?: return null
        val created = raw.epoch("created_at") ?: return null
        val updated = raw.epoch("updated_at") ?: return null
        return TreasureItemRecord(
            id = id, kind = kind, title = raw.optionalText("title", 500),
            sourceUri = raw.optionalText("source_uri", 16_384),
            sourceApp = raw.optionalText("source_app", 200),
            sourceLabel = raw.optionalText("source_label", 500).orEmpty(),
            originalText = null, bodyRef = null, previewRef = null,
            mimeType = raw.optionalText("mime_type", 200),
            byteCount = raw["byte_count"]?.jsonPrimitive?.longOrNull?.coerceAtLeast(0) ?: 0,
            contentDigest = raw.optionalText("content_digest", 64),
            summary = raw.optionalText("summary", 4_000),
            annotation = raw.optionalText("annotation", 20_000),
            tags = raw.strings("tags", 100), collectionIds = raw.strings("collection_ids", 200),
            pinned = raw["pinned"]?.jsonPrimitive?.booleanOrNull ?: false,
            archived = raw["archived"]?.jsonPrimitive?.booleanOrNull ?: false,
            readingState = raw.optionalText("reading_state", 20) ?: "none",
            readingProgress = (raw["reading_progress"]?.jsonPrimitive?.doubleOrNull ?: 0.0).coerceIn(0.0, 1.0),
            createdAt = created.toString(), updatedAt = updated.toString(),
            lastOpenedAt = raw.epoch("last_opened_at")?.toString(),
            processingState = raw.optionalText("processing_state", 20) ?: "ready",
            processingErrorCode = raw.optionalText("processing_error_code", 100),
            syncState = "remote_only", originDeviceId = origin,
            deletedAt = raw.epoch("deleted_at")?.toString(),
        )
    }

    private fun JsonObject.text(name: String, limit: Int): String? =
        this[name]?.jsonPrimitive?.contentOrNull?.trim()?.take(limit)?.takeIf(String::isNotBlank)

    private fun JsonObject.optionalText(name: String, limit: Int): String? = text(name, limit)

    private fun JsonObject.strings(name: String, limit: Int): List<String> =
        (this[name] as? JsonArray).orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull?.trim()?.take(limit) }
            .filter(String::isNotBlank).take(100)

    private fun JsonObject.epoch(name: String): Instant? {
        val seconds = this[name]?.jsonPrimitive?.doubleOrNull ?: return null
        if (seconds <= 0) return null
        return Instant.ofEpochMilli((seconds * 1_000).toLong())
    }

    private fun sha256(value: String): String = sha256(value.toByteArray())

    private fun sha256(value: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(value).toHex()

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    private companion object {
        // One dispatcher and one connection pool for every sync, treasury_get and
        // "fetch" tap; a per-call client leaked threads and reused no connection.
        val SHARED_HTTP: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .build()
        val DIGEST = Regex("^[0-9a-fA-F]{64}$")
        val KINDS = setOf("link", "text", "note", "image", "document", "audio", "video", "artifact")
        const val BODY_LIMIT = 8L * 1024 * 1024
        const val ATTACHMENT_LIMIT = 128L * 1024 * 1024
        val ALLOWED_ASSET_MIMES = setOf(
            "application/json", "application/msword", "application/octet-stream",
            "application/pdf", "application/rtf", "application/vnd.apple.keynote",
            "application/vnd.apple.numbers", "application/vnd.apple.pages",
            "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/xml", "application/zip", "audio/aac", "audio/flac", "audio/mp4",
            "audio/mpeg", "audio/ogg", "audio/wav", "audio/x-m4a", "audio/x-wav",
            "image/gif", "image/heic", "image/heif", "image/jpeg", "image/png",
            "image/tiff", "image/webp", "text/csv", "text/html", "text/markdown",
            "text/plain", "video/mp4", "video/mpeg", "video/quicktime", "video/webm",
        )
    }
}

internal data class TreasuryAssetFetchResult(
    val status: String,
    val item: TreasureItemEntity? = null,
)

/** What a ranged attachment download must do with the prefix it already retained. */
internal enum class TreasuryRangeAction { CONTINUE, TRUNCATE, RETRY, REJECT }

/**
 * 416 means the retained prefix no longer matches the relay copy, so it is dropped
 * and refetched from zero. A relay may also answer a Range request with the whole
 * body (200), which truncates the prefix without a second request. A 206 is only
 * accepted when its range continues the prefix; it may legally end before total-1.
 */
internal fun treasuryRangeAction(
    code: Int,
    offset: Long,
    contentRange: String? = null,
    total: Long = 0,
): TreasuryRangeAction = when {
    code == 416 -> if (offset > 0) TreasuryRangeAction.RETRY else TreasuryRangeAction.REJECT
    offset <= 0L -> if (code == 206) TreasuryRangeAction.REJECT else TreasuryRangeAction.CONTINUE
    code == 200 -> TreasuryRangeAction.TRUNCATE
    code == 206 -> if (validTreasuryContentRange(contentRange, offset, total)) {
        TreasuryRangeAction.CONTINUE
    } else {
        TreasuryRangeAction.REJECT
    }
    else -> TreasuryRangeAction.REJECT
}

internal fun validTreasuryContentRange(value: String?, expectedStart: Long, expectedTotal: Long): Boolean {
    val match = Regex("^bytes (\\d+)-(\\d+)/(\\d+)$").matchEntire(value.orEmpty()) ?: return false
    val start = match.groupValues[1].toLongOrNull() ?: return false
    val end = match.groupValues[2].toLongOrNull() ?: return false
    val total = match.groupValues[3].toLongOrNull() ?: return false
    return start == expectedStart && total == expectedTotal && end in start until total
}

internal data class TreasurySyncAvailability(val body: Boolean, val attachment: Boolean)

internal fun treasurySyncAvailability(record: TreasureItemRecord): TreasurySyncAvailability =
    TreasurySyncAvailability(
        body = record.originalText != null ||
            (record.kind in setOf("link", "note", "text") && record.bodyRef != null),
        attachment = record.kind in setOf("image", "document", "audio", "video", "artifact") &&
            record.bodyRef != null,
    )
