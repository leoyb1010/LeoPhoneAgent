package com.leoyuan.leophoneagent.sandbox

import java.io.File
import java.io.IOException

/** Guest paths are normalized before choosing a mount, never by the host filesystem. */
internal object GuestPathPolicy {
    fun normalize(raw: String): String? {
        if (raw.isEmpty() || raw.indexOf('\u0000') >= 0 || raw.contains('\\')) return null
        val parts = ArrayDeque<String>()
        for (part in raw.split('/')) when (part) {
            "", "." -> Unit
            ".." -> if (parts.isNotEmpty()) parts.removeLast() else return null
            else -> parts.addLast(part)
        }
        return "/" + parts.joinToString("/")
    }

    fun within(root: File, relative: String): File? = try {
        val base = root.canonicalFile
        val target = File(base, relative).canonicalFile
        if (target == base || target.toPath().startsWith(base.toPath())) target else null
    } catch (_: IOException) { null } catch (_: SecurityException) { null }

    fun validSessionId(id: String): Boolean =
        id.isNotEmpty() && id != "." && id != ".." &&
            id.none { it == '/' || it == '\\' || it == '\u0000' }
}
