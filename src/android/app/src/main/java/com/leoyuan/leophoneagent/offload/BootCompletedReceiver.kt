package com.leoyuan.leophoneagent.offload

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.leoyuan.leophoneagent.logging.AppLogger

/** System-only reboot entry point; ordinary alarm payloads never cross an exported receiver. */
class BootCompletedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        try {
            com.leoyuan.leophoneagent.scheduled.ScheduledTaskManager(context).rescheduleAll()
            AppLogger.info("BootCompletedReceiver", "scheduled tasks restored after reboot")
        } catch (t: Throwable) {
            AppLogger.warning("BootCompletedReceiver", "task restore failed: ${t.message}")
        }
    }
}
