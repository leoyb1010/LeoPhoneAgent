package com.leoyuan.leophoneagent.treasury

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path

data class TreasuryStorageUsage(
    val originalAttachmentBytes: Long,
    val syncTemporaryCacheBytes: Long,
)

/**
 * Storage accounting deliberately separates durable user content from cache.
 * `files/` contains the only copy of captured attachments and is never a
 * cleanup target. `sync-outbox/` contains bounded upload copies that can be
 * recreated from Room/original files.
 */
object TreasuryStoragePolicy {
    fun usage(root: File): TreasuryStorageUsage = TreasuryStorageUsage(
        originalAttachmentBytes = directoryBytes(File(root, "files")),
        syncTemporaryCacheBytes = directoryBytes(File(root, "sync-outbox")),
    )

    fun clearSyncTemporaryCache(root: File): Long {
        val cache = File(root, "sync-outbox")
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
