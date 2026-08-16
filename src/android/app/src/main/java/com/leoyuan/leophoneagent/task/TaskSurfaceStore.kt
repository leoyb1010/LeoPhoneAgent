package com.leoyuan.leophoneagent.task

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.SharedPreferences
import com.leoyuan.leophoneagent.data.EnvVarPrivacyStore
import com.leoyuan.leophoneagent.widget.LeoHomeWidgetProvider
import org.json.JSONObject

/**
 * Glanceable task snapshot for the home widget / QS tile.
 * Privacy mode never writes title or body — only a state enum + session id.
 */
data class TaskSurfaceSnapshot(
    val state: TaskSurfaceState,
    val sessionId: String?,
    val title: String?,
    val updatedAt: Long,
)

object TaskSurfaceStore {
    private const val PREFS = "task_surface_store"
    private const val KEY_SNAP = "snapshot_json"

    @Volatile
    private var prefs: SharedPreferences? = null

    fun init(context: Context) {
        if (prefs != null) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    fun current(): TaskSurfaceSnapshot {
        val raw = prefs?.getString(KEY_SNAP, null) ?: return idle()
        return runCatching {
            val o = JSONObject(raw)
            TaskSurfaceSnapshot(
                state = runCatching {
                    TaskSurfaceState.valueOf(o.optString("state"))
                }.getOrDefault(TaskSurfaceState.IDLE),
                sessionId = o.optString("sessionId").takeIf { it.isNotBlank() },
                title = o.optString("title").takeIf { it.isNotBlank() },
                updatedAt = o.optLong("updatedAt"),
            )
        }.getOrElse { idle() }
    }

    fun publish(context: Context, record: AgentRunRecord?, privacyOn: Boolean = EnvVarPrivacyStore.isEnabled) {
        init(context)
        val snap = TaskSurfaceSnapshot(
            state = AgentRunRecovery.surfaceState(record),
            sessionId = record?.sessionId,
            title = if (privacyOn) null else record?.title,
            updatedAt = record?.updatedAt ?: System.currentTimeMillis(),
        )
        persist(snap)
        refreshWidget(context)
    }

    fun refreshFromStore(context: Context) {
        publish(context, AgentRunStore.latest())
    }

    private fun persist(snap: TaskSurfaceSnapshot) {
        val o = JSONObject().apply {
            put("state", snap.state.name)
            snap.sessionId?.let { put("sessionId", it) }
            snap.title?.let { put("title", it) }
            put("updatedAt", snap.updatedAt)
        }
        prefs?.edit()?.putString(KEY_SNAP, o.toString())?.apply()
    }

    private fun idle(): TaskSurfaceSnapshot = TaskSurfaceSnapshot(
        state = TaskSurfaceState.IDLE,
        sessionId = null,
        title = null,
        updatedAt = 0L,
    )

    private fun refreshWidget(context: Context) {
        runCatching {
            val mgr = AppWidgetManager.getInstance(context)
            val ids = mgr.getAppWidgetIds(
                ComponentName(context, LeoHomeWidgetProvider::class.java),
            )
            if (ids.isNotEmpty()) {
                LeoHomeWidgetProvider.updateAll(context, mgr, ids)
            }
        }
    }
}
