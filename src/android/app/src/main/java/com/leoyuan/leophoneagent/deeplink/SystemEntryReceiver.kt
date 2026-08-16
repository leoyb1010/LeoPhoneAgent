package com.leoyuan.leophoneagent.deeplink

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.leoyuan.leophoneagent.logging.AppLogger
import com.leoyuan.leophoneagent.scheduled.ScheduledTaskReconcile
import com.leoyuan.leophoneagent.service.SessionActivityTracker
import com.leoyuan.leophoneagent.task.AgentRunRecovery
import com.leoyuan.leophoneagent.task.AgentRunStore
import com.leoyuan.leophoneagent.task.TaskSurfaceStore

/**
 * Notification actions, timezone/boot reconcile, and any other
 * non-Activity system entry. UI launches always go through MainActivity
 * with a minis:// URI so there is one navigation path.
 */
class SystemEntryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val app = context.applicationContext
        val extras = buildMap {
            intent?.getStringExtra(SystemEntryParser.EXTRA_SESSION_ID)?.let {
                put(SystemEntryParser.EXTRA_SESSION_ID, it)
            }
        }
        val entry = SystemEntryParser.resolve(intent?.action, intent?.dataString, extras)
        when (entry) {
            SystemEntry.Reconcile -> {
                val pending = goAsync()
                try {
                    ScheduledTaskReconcile.enqueue(app)
                } catch (t: Throwable) {
                    AppLogger.warning(TAG, "reconcile enqueue failed: ${t.message}")
                } finally {
                    pending.finish()
                }
            }
            is SystemEntry.PauseSession -> {
                runCatching { SessionActivityTracker.cancelAllActiveStreams() }
                entry.sessionId?.let {
                    AgentRunStore.markWaitingUser(it, AgentRunRecovery.REASON_USER_PAUSE)
                }
                TaskSurfaceStore.refreshFromStore(app)
            }
            is SystemEntry.ResumeSession -> launch(app, SystemEntryParser.resumeUri(entry.sessionId))
            is SystemEntry.OpenSession -> launch(app, SystemEntryParser.sessionUri(entry.sessionId))
            SystemEntry.NewChat -> launch(app, SystemEntryParser.NEW_CHAT_URI)
            SystemEntry.VoiceChat -> launch(app, SystemEntryParser.VOICE_CHAT_URI)
            SystemEntry.LastSession -> launch(app, SystemEntryParser.LAST_SESSION_URI)
            else -> launch(app, SystemEntryParser.NEW_CHAT_URI)
        }
    }

    private fun launch(context: Context, uri: String) {
        runCatching {
            context.startActivity(SystemEntryIntents.viewIntent(context, uri))
        }.onFailure {
            AppLogger.warning(TAG, "launch failed: ${it.message}")
        }
    }

    companion object {
        private const val TAG = "SystemEntryReceiver"
    }
}
