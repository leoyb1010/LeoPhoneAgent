package com.leoyuan.leophoneagent.sandbox

enum class CliAuthState { SIGNED_IN, SIGNED_OUT, UNAVAILABLE }

/** Parsed per-tool outcome of [CliToolCatalog.combinedStatusCommand]. */
data class CliStatusEntry(
    val installed: Boolean,
    val version: String?,
    val authState: CliAuthState = CliAuthState.UNAVAILABLE,
    val authDetail: String? = null,
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
        val auth = mutableMapOf<CliToolId, Pair<Int, String?>>()
        output.lineSequence().forEach { line ->
            val trimmed = line.trim()
            val marker = when {
                trimmed.startsWith(CliToolCatalog.AUTH_MARKER) -> CliToolCatalog.AUTH_MARKER
                trimmed.startsWith(CliToolCatalog.STATUS_MARKER) -> CliToolCatalog.STATUS_MARKER
                else -> return@forEach
            }
            val rest = trimmed.removePrefix(marker).trim()
            val parts = rest.split(" ", limit = 3)
            if (parts.size < 2) return@forEach
            val id = runCatching { CliToolId.valueOf(parts[0]) }.getOrNull() ?: return@forEach
            val rc = parts[1].toIntOrNull() ?: return@forEach
            val detail = parts.getOrNull(2)?.trim()?.takeIf { it.isNotEmpty() }?.take(120)
            if (marker == CliToolCatalog.AUTH_MARKER) {
                auth[id] = rc to detail
            } else {
                found[id] = if (rc == 0) CliStatusEntry(installed = true, version = detail)
                else CliStatusEntry(installed = false, version = null)
            }
        }
        return CliToolId.entries.associateWith { id ->
            val base = found[id] ?: CliStatusEntry(installed = false, version = null)
            val authProbe = auth[id]
            when {
                !base.installed -> base
                authProbe != null -> base.copy(
                    authState = classifyAuth(authProbe.first, authProbe.second),
                    authDetail = authProbe.second,
                )
                else -> base
            }
        }
    }

    /** Some official CLIs return exit 0 even for an expired/signed-out account. */
    internal fun classifyAuth(rc: Int, detail: String?): CliAuthState {
        if (rc == 127) return CliAuthState.UNAVAILABLE
        val normalized = detail.orEmpty().lowercase()
        val signedOutText = listOf(
            "not logged in",
            "not signed in",
            "logged out",
            "login: expired",
            "unauthenticated",
        ).any(normalized::contains)
        return if (rc == 0 && !signedOutText) CliAuthState.SIGNED_IN else CliAuthState.SIGNED_OUT
    }
}
