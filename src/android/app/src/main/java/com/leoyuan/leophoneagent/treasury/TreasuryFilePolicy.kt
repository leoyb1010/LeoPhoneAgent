package com.leoyuan.leophoneagent.treasury

import java.io.File
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.LinkOption

internal object TreasuryFilePolicy {
    fun managedFile(root: File, relativeRef: String?, maxBytes: Long): File? {
        if (relativeRef == null || maxBytes < 0 ||
            !com.leoyuan.leophoneagent.data.repository.TreasureRepository.isSafeRelativeRef(relativeRef)
        ) return null
        if (Files.isSymbolicLink(root.toPath())) return null
        val canonicalRoot = runCatching { root.canonicalFile }.getOrNull() ?: return null
        val candidate = File(canonicalRoot, relativeRef)
        if (Files.isSymbolicLink(candidate.toPath())) return null
        val canonical = runCatching { candidate.canonicalFile }.getOrNull() ?: return null
        if (!canonical.path.startsWith(canonicalRoot.path + File.separator) ||
            !Files.isRegularFile(canonical.toPath(), LinkOption.NOFOLLOW_LINKS)
        ) return null
        val size = runCatching { Files.size(canonical.toPath()) }.getOrNull() ?: return null
        return canonical.takeIf { size <= maxBytes }
    }

    /** Copies a raw capture and removes any partial target when the read or write fails. */
    fun copyToFileLimited(input: InputStream, target: File, maxBytes: Long): Long {
        require(maxBytes >= 0)
        var byteCount = 0L
        try {
            target.outputStream().buffered().use { output ->
                val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    byteCount += count
                    require(byteCount <= maxBytes) { "Capture exceeds limit" }
                    output.write(buffer, 0, count)
                }
            }
            return byteCount
        } catch (error: Throwable) {
            target.delete()
            throw error
        }
    }

    /** Reads at most [maxChars] UTF-16 characters without loading the entire file. */
    fun readUtf8TextLimited(file: File, maxChars: Int): String {
        require(maxChars > 0)
        return file.inputStream().bufferedReader(Charsets.UTF_8).use { reader ->
            val result = StringBuilder(minOf(maxChars, 64 * 1024))
            val buffer = CharArray(8 * 1024)
            while (result.length < maxChars) {
                val count = reader.read(buffer, 0, minOf(buffer.size, maxChars - result.length))
                if (count < 0) break
                result.append(buffer, 0, count)
            }
            result.toString()
        }
    }
}
