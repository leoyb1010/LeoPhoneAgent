package com.leoyuan.leophoneagent.shortcut

import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import com.leoyuan.leophoneagent.MainActivity
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.deeplink.SystemEntryParser
import com.leoyuan.leophoneagent.task.AgentRunStore

/** Publishes the dynamic "last session" App Shortcut. Static XML keeps new/voice. */
object AppShortcutPublisher {
    private const val LAST_SESSION_ID = "last_session"

    fun refresh(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return
        runCatching {
            val sm = context.getSystemService(ShortcutManager::class.java) ?: return
            val sessionId = AgentRunStore.lastSessionId()
            val uri = if (sessionId.isNullOrBlank()) {
                SystemEntryParser.LAST_SESSION_URI
            } else {
                SystemEntryParser.sessionUri(sessionId)
            }
            val info = ShortcutInfo.Builder(context, LAST_SESSION_ID)
                .setShortLabel(context.getString(R.string.shortcut_last_session_short))
                .setLongLabel(context.getString(R.string.shortcut_last_session_long))
                .setIcon(Icon.createWithResource(context, R.mipmap.ic_shortcut_new_chat))
                .setIntent(
                    Intent(context, MainActivity::class.java).apply {
                        action = Intent.ACTION_VIEW
                        data = Uri.parse(uri)
                    },
                )
                .build()
            sm.dynamicShortcuts = listOf(info)
        }
    }
}
