package com.leoyuan.leophoneagent.assistant

import android.content.Intent

/**
 * Parses system-assistant launch extras without touching RoleManager.
 * Used by ACTION_ASSIST, VoiceInteractionSession, QS tile, and tests.
 */
object AssistIntents {
    const val ACTION_ASSIST = "android.intent.action.ASSIST"
    const val ACTION_VOICE_COMMAND = "android.intent.action.VOICE_COMMAND"
    const val EXTRA_ASSIST_PACKAGE = "android.intent.extra.ASSIST_PACKAGE"
    const val EXTRA_SOURCE_PACKAGE = "com.leoyuan.leophoneagent.extra.ASSIST_PACKAGE"
    const val EXTRA_SCREENSHOT_PATH = "com.leoyuan.leophoneagent.extra.ASSIST_SCREENSHOT"
    const val NEW_CHAT_URI = "minis://action/new_chat"
    const val VOICE_CHAT_URI = "minis://action/voice_chat"

    data class Launch(
        val sourcePackage: String?,
        val screenshotPath: String?,
    )

    fun isAssistAction(action: String?): Boolean =
        action == ACTION_ASSIST || action == ACTION_VOICE_COMMAND

    fun parse(action: String?, extras: Map<String, String?>): Launch? {
        val pkg = extras[EXTRA_SOURCE_PACKAGE]?.ifBlank { null }
            ?: extras[EXTRA_ASSIST_PACKAGE]?.ifBlank { null }
        val shot = extras[EXTRA_SCREENSHOT_PATH]?.ifBlank { null }
        if (!isAssistAction(action) && pkg == null && shot == null) return null
        return Launch(pkg, shot)
    }

    fun fromIntent(intent: Intent?): Launch? {
        if (intent == null) return null
        val extras = buildMap {
            intent.getStringExtra(EXTRA_SOURCE_PACKAGE)?.let { put(EXTRA_SOURCE_PACKAGE, it) }
            intent.getStringExtra(EXTRA_ASSIST_PACKAGE)?.let { put(EXTRA_ASSIST_PACKAGE, it) }
            intent.getStringExtra(EXTRA_SCREENSHOT_PATH)?.let { put(EXTRA_SCREENSHOT_PATH, it) }
        }
        return parse(intent.action, extras)
    }
}
