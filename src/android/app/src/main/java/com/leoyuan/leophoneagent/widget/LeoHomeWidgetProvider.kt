package com.leoyuan.leophoneagent.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.deeplink.SystemEntryIntents
import com.leoyuan.leophoneagent.deeplink.SystemEntryParser
import com.leoyuan.leophoneagent.task.TaskSurfaceState
import com.leoyuan.leophoneagent.task.TaskSurfaceStore

/**
 * Home-screen task surface: idle / running / paused / completed / needs
 * attention. Tap the status row to open the matching session. Voice
 * recording only starts after the foreground App opens.
 */
class LeoHomeWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        updateAll(context, appWidgetManager, appWidgetIds)
    }

    companion object {
        fun updateAll(
            context: Context,
            appWidgetManager: AppWidgetManager,
            appWidgetIds: IntArray,
        ) {
            val views = runCatching { buildViews(context) }.getOrElse {
                RemoteViews(context.packageName, R.layout.leo_home_widget)
            }
            for (id in appWidgetIds) {
                runCatching { appWidgetManager.updateAppWidget(id, views) }
            }
        }

        fun buildViews(context: Context): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.leo_home_widget)
            val snap = runCatching { TaskSurfaceStore.current() }.getOrNull()
            val state = snap?.state ?: TaskSurfaceState.IDLE
            val statusText = when (state) {
                TaskSurfaceState.IDLE -> context.getString(R.string.task_state_idle)
                TaskSurfaceState.RUNNING -> context.getString(R.string.task_state_running)
                TaskSurfaceState.PAUSED -> context.getString(R.string.task_state_paused)
                TaskSurfaceState.COMPLETED -> context.getString(R.string.task_state_completed)
                TaskSurfaceState.NEEDS_ATTENTION -> context.getString(R.string.task_state_needs_attention)
            }
            views.setTextViewText(R.id.widget_status, statusText)
            // Privacy: never write session title/body onto the widget.
            views.setTextViewText(R.id.widget_title, context.getString(R.string.widget_title))

            val statusUri = snap?.sessionId
                ?.takeIf { state != TaskSurfaceState.IDLE }
                ?.let { SystemEntryParser.sessionUri(it) }
                ?: SystemEntryParser.NEW_CHAT_URI
            views.setOnClickPendingIntent(
                R.id.widget_root,
                SystemEntryIntents.activity(context, statusUri, 3),
            )
            views.setOnClickPendingIntent(
                R.id.widget_status,
                SystemEntryIntents.activity(context, statusUri, 4),
            )
            views.setOnClickPendingIntent(
                R.id.widget_new_chat,
                SystemEntryIntents.activity(context, SystemEntryParser.NEW_CHAT_URI, 1),
            )
            views.setOnClickPendingIntent(
                R.id.widget_voice_chat,
                SystemEntryIntents.activity(context, SystemEntryParser.VOICE_CHAT_URI, 2),
            )
            return views
        }
    }
}
