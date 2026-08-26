package com.leoyuan.leophoneagent.tools

/**
 * Shared file_read pagination. Android / iOS / Harmony must emit the same
 * `next_offset` so the model can continue a long file without guessing.
 *
 * `next_offset` is the 1-based line to pass as `offset` on the next head read.
 * Tail reads never emit it. A finished head read omits it.
 */
object FileReadPaging {
    const val HARD_CAP = 80_000
    const val DEFAULT_MAX_LENGTH = 15_000

    data class Page(
        val showStart: Int,
        val showEnd: Int,
        val totalLines: Int,
        val content: String,
        val truncated: Boolean,
        val nextOffset: Int?,
    )

    fun page(
        allLines: List<String>,
        offset: Int,
        requestedLines: Int?,
        maxLength: Int,
        direction: String,
    ): Page {
        val total = allLines.size
        val cap = maxLength.coerceAtMost(HARD_CAP).coerceAtLeast(1)
        if (total == 0) {
            return Page(1, 0, 0, "", false, null)
        }
        val isTail = direction.equals("tail", ignoreCase = true)
        val selected: List<String>
        val showStart: Int
        if (isTail) {
            val count = requestedLines ?: total
            val start = (total - count).coerceAtLeast(0)
            selected = allLines.subList(start, total)
            showStart = start + 1
        } else {
            val start = (offset.coerceAtLeast(1) - 1).coerceIn(0, total)
            val end = if (requestedLines != null) {
                (start + requestedLines.coerceAtLeast(0)).coerceAtMost(total)
            } else {
                total
            }
            selected = allLines.subList(start, end)
            showStart = if (selected.isEmpty()) offset.coerceAtLeast(1) else start + 1
        }
        return clip(selected, showStart, total, cap, isTail)
    }

    private fun clip(
        selected: List<String>,
        showStart: Int,
        total: Int,
        cap: Int,
        isTail: Boolean,
    ): Page {
        if (selected.isEmpty()) {
            return Page(showStart, showStart - 1, total, "", false, null)
        }
        val joined = selected.joinToString("\n")
        if (joined.length <= cap) {
            val showEnd = showStart + selected.size - 1
            val next = if (!isTail && showEnd < total) showEnd + 1 else null
            return Page(showStart, showEnd, total, joined, false, next)
        }
        var used = 0
        var complete = 0
        for (line in selected) {
            val extra = if (complete == 0) 0 else 1
            if (used + extra + line.length > cap) break
            used += extra + line.length
            complete++
        }
        return if (complete == 0) {
            val showEnd = showStart
            val next = if (isTail) null else showStart + 1
            Page(showStart, showEnd, total, selected.first().take(cap), true, next)
        } else {
            val showEnd = showStart + complete - 1
            val content = selected.subList(0, complete).joinToString("\n")
            val next = if (!isTail && showEnd < total) showEnd + 1 else null
            Page(showStart, showEnd, total, content, true, next)
        }
    }

    fun formatOutput(path: String, size: Long, page: Page): String {
        val range = if (page.totalLines == 0 || page.showEnd < page.showStart) {
            "showing 0-0 of 0"
        } else {
            "showing ${page.showStart}-${page.showEnd} of ${page.totalLines}"
        }
        val trunc = if (page.truncated) " (truncated at ${HARD_CAP} chars or requested max_length)" else ""
        val header = "[$path | $size bytes | ${page.totalLines} lines | $range$trunc]"
        val next = page.nextOffset?.let { "\nnext_offset: $it" } ?: ""
        return "$header\n${page.content}$next"
    }
}
