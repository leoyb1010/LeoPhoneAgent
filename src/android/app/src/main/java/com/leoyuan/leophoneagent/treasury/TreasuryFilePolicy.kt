package com.leoyuan.leophoneagent.treasury

import java.io.File
import java.io.InputStream

internal object TreasuryFilePolicy {
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
