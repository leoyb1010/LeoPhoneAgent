package com.leoyuan.leophoneagent.sandbox

/** Parsed per-tool outcome of [CliToolCatalog.combinedStatusCommand]. */
data class CliStatusEntry(
    val installed: Boolean,
    val version: String?,
)

object CliStatusReport {

    /**
     * Parse the `___LEO_CLI___ <id> <rc> <version line>` marker lines emitted
     * by the combined status probe. Tools missing from the output (e.g. the
     * shell died halfway) are reported as not installed rather than being
     * silently dropped — the UI must always have a row per catalog tool.
     */
    fun parse(output: String): Map<CliToolId, CliStatusEntry> {
        val found = mutableMapOf<CliToolId, CliStatusEntry>()
        output.lineSequence().forEach { line ->
            val trimmed = line.trim()
            if (!trimmed.startsWith(CliToolCatalog.STATUS_MARKER)) return@forEach
            val rest = trimmed.removePrefix(CliToolCatalog.STATUS_MARKER).trim()
            val parts = rest.split(" ", limit = 3)
            if (parts.size < 2) return@forEach
            val id = runCatching { CliToolId.valueOf(parts[0]) }.getOrNull() ?: return@forEach
            val rc = parts[1].toIntOrNull() ?: return@forEach
            val version = parts.getOrNull(2)?.trim()?.takeIf { it.isNotEmpty() }?.take(120)
            found[id] = if (rc == 0) CliStatusEntry(installed = true, version = version)
            else CliStatusEntry(installed = false, version = null)
        }
        return CliToolId.entries.associateWith { id ->
            found[id] ?: CliStatusEntry(installed = false, version = null)
        }
    }
}
