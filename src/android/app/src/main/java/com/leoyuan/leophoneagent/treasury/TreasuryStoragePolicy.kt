package com.leoyuan.leophoneagent.treasury

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicInteger

data class TreasuryStorageUsage(
    val originalAttachmentBytes: Long,
    val syncTemporaryCacheBytes: Long,
)

/**
 * Storage accounting deliberately separates durable user content from cache.
 * `files/` contains the only copy of captured attachments and is never a
 * cleanup target. `sync-outbox/`, `sync-inbox/`, and `remote-assets/` contain
 * upload copies, resumable partial downloads, and re-downloadable remote files.
 */
object TreasuryStoragePolicy {
    fun usage(root: File): TreasuryStorageUsage = TreasuryStorageUsage(
        originalAttachmentBytes = directoryBytes(File(root, "files")),
        syncTemporaryCacheBytes = listOf("sync-outbox", "sync-inbox", "remote-assets")
            .fold(0L) { total, name -> saturatedAdd(total, directoryBytes(File(root, name))) },
    )

    private val downloadsInFlight = AtomicInteger()

    /**
     * A streaming attachment download keeps its `.partial` open. Unlinking that file
     * mid-flight makes the download finish into an unlinked inode and fail the later
     * `isRegularFile` check, so the clear path skips `sync-inbox` while one runs.
     */
    // ponytail: one process-wide counter, not per root or per file. A second
    // Treasury root would need a keyed map; there is only ever one.
    internal fun <T> whileDownloading(block: () -> T): T {
        downloadsInFlight.incrementAndGet()
        return try {
            block()
        } finally {
            downloadsInFlight.decrementAndGet()
        }
    }

    fun clearSyncTemporaryCache(root: File): Long =
        listOf("sync-outbox", "sync-inbox", "remote-assets")
            .filterNot { it == "sync-inbox" && downloadsInFlight.get() > 0 }
            .sumOf { clearCacheDirectory(File(root, it)) }

    private fun clearCacheDirectory(cache: File): Long {
        val cachePath = cache.toPath()
        if (Files.isSymbolicLink(cachePath) ||
            !Files.isDirectory(cachePath, LinkOption.NOFOLLOW_LINKS)
        ) return 0L

        val before = directoryBytes(cache)
        try {
            Files.newDirectoryStream(cachePath).use { entries ->
                entries.forEach { entry ->
                    // Sync outbox writes flat temporary files. Refuse unexpected
                    // directories; deleting a symlink itself never follows its target.
                    if (Files.isSymbolicLink(entry) ||
                        Files.isRegularFile(entry, LinkOption.NOFOLLOW_LINKS)
                    ) {
                        runCatching { Files.deleteIfExists(entry) }
                    }
                }
            }
        } catch (_: IOException) {
            // Best-effort cache cleanup must never endanger durable content.
        } catch (_: SecurityException) {
            // A restricted entry stays untouched and is reflected in the next usage scan.
        }
        return (before - directoryBytes(cache)).coerceAtLeast(0L)
    }

    private fun saturatedAdd(left: Long, right: Long): Long =
        if (Long.MAX_VALUE - left < right) Long.MAX_VALUE else left + right

    internal fun directoryBytes(directory: File): Long {
        val root = directory.toPath()
        if (Files.isSymbolicLink(root) ||
            !Files.isDirectory(root, LinkOption.NOFOLLOW_LINKS)
        ) return 0L

        var total = 0L
        val pending = ArrayDeque<Path>()
        pending.add(root)
        while (pending.isNotEmpty()) {
            val current = pending.removeLast()
            try {
                Files.newDirectoryStream(current).use { entries ->
                    entries.forEach { entry ->
                        when {
                            Files.isSymbolicLink(entry) -> Unit
                            Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS) -> pending.add(entry)
                            Files.isRegularFile(entry, LinkOption.NOFOLLOW_LINKS) -> {
                                val size = runCatching { Files.size(entry) }.getOrDefault(0L)
                                total = if (Long.MAX_VALUE - total < size) Long.MAX_VALUE else total + size
                            }
                        }
                    }
                }
            } catch (_: IOException) {
                // Ignore an unreadable subtree while preserving the rest of the accounting.
            } catch (_: SecurityException) {
                // Restricted paths are intentionally not traversed.
            }
        }
        return total
    }
}
