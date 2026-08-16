package com.leoyuan.leophoneagent.offload

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.leoyuan.leophoneagent.deeplink.SystemEntry
import com.leoyuan.leophoneagent.deeplink.SystemEntryParser
import com.leoyuan.leophoneagent.logging.AppLogger
import com.leoyuan.leophoneagent.scheduled.ScheduledTaskReconcile

/** Boot / timezone / replace entry — same reconcile path as notification actions. */
class BootCompletedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val entry = SystemEntryParser.resolve(intent.action, intent.dataString)
        if (entry !is SystemEntry.Reconcile &&
            intent.action != Intent.ACTION_BOOT_COMPLETED
        ) {
            return
        }
        try {
            ScheduledTaskReconcile.enqueue(context.applicationContext)
            AppLogger.info("BootCompletedReceiver", "reconcile enqueued action=${intent.action}")
        } catch (t: Throwable) {
            AppLogger.warning("BootCompletedReceiver", "reconcile failed: ${t.message}")
        }
    }
}
