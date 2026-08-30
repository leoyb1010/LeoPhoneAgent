package com.leoyuan.leophoneagent.treasury

import java.time.LocalDate
import java.time.ZoneOffset
import java.util.Locale

data class TreasuryQuerySpec(
    val textQuery: String,
    val kinds: Set<String> = emptySet(),
    val processingStates: Set<String> = emptySet(),
    val readingStates: Set<String> = emptySet(),
    val tags: Set<String> = emptySet(),
    val pinned: Boolean? = null,
    val archived: Boolean = false,
    val recent: Boolean = false,
    val afterEpochMs: Long? = null,
    val beforeEpochMs: Long? = null,
)

object TreasuryQuery {
    private val kinds = setOf("link", "text", "note", "image", "document", "audio", "video", "artifact")
    private val processing = setOf("saved", "queued", "processing", "ready", "partial", "failed")
    private val reading = setOf("none", "unread", "reading", "read")

    fun parse(raw: String): TreasuryQuerySpec {
        val text = mutableListOf<String>()
        val foundKinds = linkedSetOf<String>()
        val foundProcessing = linkedSetOf<String>()
        val foundReading = linkedSetOf<String>()
        val foundTags = linkedSetOf<String>()
        var pinned: Boolean? = null
        var archived = false
        var recent = false
        var after: Long? = null
        var before: Long? = null

        raw.trim().take(512).split(Regex("\\s+")).filter(String::isNotBlank).forEach { token ->
            val name = token.substringBefore(':', "").lowercase(Locale.ROOT)
            val value = token.substringAfter(':', "").trim().lowercase(Locale.ROOT)
            val values = value.split(',').filter(String::isNotBlank)
            val consumed = when (name) {
                "type", "kind" -> values.filter(kinds::contains).let { foundKinds.addAll(it); it.isNotEmpty() }
                "state", "process" -> values.filter(processing::contains).let { foundProcessing.addAll(it); it.isNotEmpty() }
                "read", "reading" -> values.filter(reading::contains).let { foundReading.addAll(it); it.isNotEmpty() }
                "tag" -> values.map { it.take(100) }.let { foundTags.addAll(it); it.isNotEmpty() }
                "is" -> when (value) {
                    "pinned" -> { pinned = true; true }
                    "unpinned" -> { pinned = false; true }
                    "archived" -> { archived = true; true }
                    "recent" -> { recent = true; true }
                    else -> false
                }
                "after" -> parseDate(value)?.let { after = it; true } ?: false
                "before" -> parseDate(value)?.let { before = it; true } ?: false
                else -> false
            }
            if (!consumed) text += token
        }
        return TreasuryQuerySpec(
            textQuery = text.joinToString(" "), kinds = foundKinds,
            processingStates = foundProcessing, readingStates = foundReading,
            tags = foundTags, pinned = pinned, archived = archived, recent = recent,
            afterEpochMs = after, beforeEpochMs = before,
        )
    }

    private fun parseDate(value: String): Long? = runCatching {
        LocalDate.parse(value).atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli()
    }.getOrNull()
}
