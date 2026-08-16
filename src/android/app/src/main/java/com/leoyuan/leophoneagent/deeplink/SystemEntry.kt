package com.leoyuan.leophoneagent.deeplink

/**
 * Single product entry for every Android system surface: launcher, tile,
 * widget, assistant, notification action, share, shortcut, boot/timezone
 * reconcile. Parsing is string-based so JVM tests do not need Uri stubs.
 *
 * Failures always become [Home] — never throw into an Activity/Service.
 */
sealed class SystemEntry {
    data object Home : SystemEntry()
    data object NewChat : SystemEntry()
    data object VoiceChat : SystemEntry()
    data object CameraChat : SystemEntry()
    data object LastSession : SystemEntry()
    data class OpenSession(val sessionId: String) : SystemEntry()
    data class ResumeSession(val sessionId: String) : SystemEntry()
    data class PauseSession(val sessionId: String?) : SystemEntry()
    data class Assist(val sourcePackage: String?, val screenshotPath: String?) : SystemEntry()
    data object Reconcile : SystemEntry()
}

object SystemEntryParser {
    const val ACTION_ASSIST = "android.intent.action.ASSIST"
    const val ACTION_VOICE_COMMAND = "android.intent.action.VOICE_COMMAND"
    const val ACTION_BOOT_COMPLETED = "android.intent.action.BOOT_COMPLETED"
    const val ACTION_TIMEZONE_CHANGED = "android.intent.action.TIMEZONE_CHANGED"
    const val ACTION_TIME_CHANGED = "android.intent.action.TIME_SET"
    const val ACTION_MY_PACKAGE_REPLACED = "android.intent.action.MY_PACKAGE_REPLACED"
    const val ACTION_PAUSE = "com.leoyuan.leophoneagent.action.PAUSE_SESSION"
    const val ACTION_RESUME = "com.leoyuan.leophoneagent.action.RESUME_SESSION"
    const val ACTION_OPEN = "com.leoyuan.leophoneagent.action.OPEN_SESSION"

    const val EXTRA_SOURCE_PACKAGE = "com.leoyuan.leophoneagent.extra.ASSIST_PACKAGE"
    const val EXTRA_ASSIST_PACKAGE = "android.intent.extra.ASSIST_PACKAGE"
    const val EXTRA_SCREENSHOT_PATH = "com.leoyuan.leophoneagent.extra.ASSIST_SCREENSHOT"
    const val EXTRA_SESSION_ID = "com.leoyuan.leophoneagent.extra.SESSION_ID"

    const val NEW_CHAT_URI = "minis://action/new_chat"
    const val VOICE_CHAT_URI = "minis://action/voice_chat"
    const val LAST_SESSION_URI = "minis://action/last_session"

    fun sessionUri(sessionId: String): String = "minis://session/$sessionId"
    fun resumeUri(sessionId: String): String = "minis://action/resume?session=$sessionId"
    fun pauseUri(sessionId: String): String = "minis://action/pause?session=$sessionId"

    fun resolve(
        action: String?,
        data: String?,
        extras: Map<String, String?> = emptyMap(),
    ): SystemEntry {
        return try {
            resolveUnsafe(action, data, extras)
        } catch (_: Throwable) {
            SystemEntry.Home
        }
    }

    fun parseData(data: String?): SystemEntry = resolve(action = null, data = data)

    fun toDeepLinkAction(entry: SystemEntry): DeepLinkAction = when (entry) {
        SystemEntry.Home -> DeepLinkAction.Unknown
        SystemEntry.NewChat, is SystemEntry.Assist -> DeepLinkAction.NewChat
        SystemEntry.VoiceChat -> DeepLinkAction.NewVoiceChat
        SystemEntry.CameraChat -> DeepLinkAction.NewCameraChat
        SystemEntry.LastSession -> DeepLinkAction.LastSession
        is SystemEntry.OpenSession -> DeepLinkAction.OpenSession(entry.sessionId)
        is SystemEntry.ResumeSession -> DeepLinkAction.ResumeSession(entry.sessionId)
        is SystemEntry.PauseSession -> DeepLinkAction.PauseSession(entry.sessionId)
        SystemEntry.Reconcile -> DeepLinkAction.Unknown
    }

    private fun resolveUnsafe(
        action: String?,
        data: String?,
        extras: Map<String, String?>,
    ): SystemEntry {
        when (action) {
            ACTION_BOOT_COMPLETED,
            ACTION_TIMEZONE_CHANGED,
            ACTION_TIME_CHANGED,
            ACTION_MY_PACKAGE_REPLACED,
            -> return SystemEntry.Reconcile
            ACTION_PAUSE -> return SystemEntry.PauseSession(
                extras[EXTRA_SESSION_ID]?.ifBlank { null },
            )
            ACTION_RESUME -> extras[EXTRA_SESSION_ID]?.ifBlank { null }?.let {
                return SystemEntry.ResumeSession(it)
            }
            ACTION_OPEN -> extras[EXTRA_SESSION_ID]?.ifBlank { null }?.let {
                return SystemEntry.OpenSession(it)
            }
            ACTION_ASSIST, ACTION_VOICE_COMMAND -> {
                val fromData = data?.let { parseMinis(it) }
                if (fromData is SystemEntry.NewChat ||
                    fromData is SystemEntry.VoiceChat ||
                    fromData is SystemEntry.OpenSession
                ) {
                    return SystemEntry.Assist(
                        sourcePackage = extraPackage(extras),
                        screenshotPath = extras[EXTRA_SCREENSHOT_PATH]?.ifBlank { null },
                    )
                }
                return SystemEntry.Assist(
                    sourcePackage = extraPackage(extras),
                    screenshotPath = extras[EXTRA_SCREENSHOT_PATH]?.ifBlank { null },
                )
            }
        }
        val parsed = parseMinis(data)
        if (parsed !is SystemEntry.Home) return parsed
        extraPackage(extras)?.let { pkg ->
            return SystemEntry.Assist(pkg, extras[EXTRA_SCREENSHOT_PATH]?.ifBlank { null })
        }
        extras[EXTRA_SCREENSHOT_PATH]?.ifBlank { null }?.let {
            return SystemEntry.Assist(null, it)
        }
        extras[EXTRA_SESSION_ID]?.ifBlank { null }?.let {
            return SystemEntry.OpenSession(it)
        }
        return SystemEntry.Home
    }

    private fun extraPackage(extras: Map<String, String?>): String? =
        extras[EXTRA_SOURCE_PACKAGE]?.ifBlank { null}
            ?: extras[EXTRA_ASSIST_PACKAGE]?.ifBlank { null }

    internal fun parseMinis(raw: String?): SystemEntry {
        if (raw.isNullOrBlank()) return SystemEntry.Home
        val uri = raw.trim()
        val schemeEnd = uri.indexOf("://")
        if (schemeEnd <= 0) return SystemEntry.Home
        val scheme = uri.substring(0, schemeEnd).lowercase()
        if (scheme != "minis" && scheme != "leophoneagent") return SystemEntry.Home
        val rest = uri.substring(schemeEnd + 3)
        val queryStart = rest.indexOf('?')
        val beforeQuery = if (queryStart >= 0) rest.substring(0, queryStart) else rest
        val query = if (queryStart >= 0) rest.substring(queryStart + 1) else ""
        val slash = beforeQuery.indexOf('/')
        val host = if (slash >= 0) beforeQuery.substring(0, slash) else beforeQuery
        val path = if (slash >= 0) beforeQuery.substring(slash + 1) else ""
        val params = parseQuery(query)
        return when (host) {
            "action" -> when (path.substringBefore('/')) {
                "new_chat" -> SystemEntry.NewChat
                "voice_chat" -> SystemEntry.VoiceChat
                "camera_chat" -> SystemEntry.CameraChat
                "last_session" -> SystemEntry.LastSession
                "resume" -> params["session"]?.ifBlank { null }?.let {
                    SystemEntry.ResumeSession(it)
                } ?: SystemEntry.LastSession
                "pause" -> SystemEntry.PauseSession(params["session"]?.ifBlank { null })
                else -> SystemEntry.Home
            }
            "session" -> {
                val sid = path.substringBefore('/').ifBlank { null } ?: return SystemEntry.Home
                SystemEntry.OpenSession(sid)
            }
            else -> SystemEntry.Home
        }
    }

    private fun parseQuery(query: String): Map<String, String> {
        if (query.isBlank()) return emptyMap()
        return query.split('&').mapNotNull { part ->
            val eq = part.indexOf('=')
            if (eq <= 0) return@mapNotNull null
            val key = decode(part.substring(0, eq))
            val value = decode(part.substring(eq + 1))
            key to value
        }.toMap()
    }

    private fun decode(value: String): String =
        value.replace('+', ' ').replace(Regex("%([0-9A-Fa-f]{2})")) { match ->
            match.groupValues[1].toInt(16).toChar().toString()
        }
}
