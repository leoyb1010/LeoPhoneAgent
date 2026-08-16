package com.leoyuan.leophoneagent.deeplink

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.leoyuan.leophoneagent.MainActivity

/** Builds PendingIntents that all land on [MainActivity] via [SystemEntryParser]. */
object SystemEntryIntents {
    fun activity(
        context: Context,
        uri: String,
        requestCode: Int,
        action: String = Intent.ACTION_VIEW,
        extras: Map<String, String> = emptyMap(),
    ): PendingIntent {
        val intent = viewIntent(context, uri, action, extras)
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    fun viewIntent(
        context: Context,
        uri: String,
        action: String = Intent.ACTION_VIEW,
        extras: Map<String, String> = emptyMap(),
    ): Intent = Intent(context, MainActivity::class.java).apply {
        this.action = action
        data = Uri.parse(uri)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        extras.forEach { (k, v) -> putExtra(k, v) }
    }

    fun broadcast(
        context: Context,
        action: String,
        sessionId: String?,
        requestCode: Int,
    ): PendingIntent {
        val intent = Intent(context, SystemEntryReceiver::class.java).apply {
            this.action = action
            sessionId?.let { putExtra(SystemEntryParser.EXTRA_SESSION_ID, it) }
        }
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }
}
