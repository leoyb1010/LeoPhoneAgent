package com.leoyuan.leophoneagent.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import com.leoyuan.leophoneagent.MainActivity
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.assistant.AssistIntents

/** Home-screen widget: new chat + voice chat, same deep-links as shortcuts. */
class LeoHomeWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        for (id in appWidgetIds) {
            appWidgetManager.updateAppWidget(id, buildViews(context))
        }
    }

    companion object {
        fun buildViews(context: Context): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.leo_home_widget)
            views.setOnClickPendingIntent(
                R.id.widget_new_chat,
                clickIntent(context, AssistIntents.NEW_CHAT_URI, 1),
            )
            views.setOnClickPendingIntent(
                R.id.widget_voice_chat,
                clickIntent(context, AssistIntents.VOICE_CHAT_URI, 2),
            )
            return views
        }

        private fun clickIntent(context: Context, uri: String, requestCode: Int): PendingIntent {
            val intent = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_VIEW
                data = Uri.parse(uri)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            }
            return PendingIntent.getActivity(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
    }
}
