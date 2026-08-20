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
        // T-relay-body-alive: 开机复活「Android 身体」。
        //
        // why 在 BOOT_COMPLETED 里做：这是 Android 12+ 少数几个允许从后台拉起
        // 前台服务的上下文之一。Android 14 进一步限制了可在开机时启动的 FGS
        // 类型（dataSync / camera / mediaPlayback / microphone 等都不行），
        // `remoteMessaging` 在允许之列 —— 这正是
        // RelayBodyForegroundService 选它的原因之一。
        //
        // 加密存储读取放到后台线程：BroadcastReceiver.onReceive 跑在主线程上，
        // 而 RelayFleetStore 第一次访问要解 Keystore。
        val app = context.applicationContext
        val pending = goAsync()
        Thread {
            try {
                if (com.leoyuan.leophoneagent.relay.RelayBodyService.isBodyEnabled(app)) {
                    com.leoyuan.leophoneagent.relay.RelayBodyService.start(app)
                    com.leoyuan.leophoneagent.service.RelayBodyForegroundService.start(app)
                    com.leoyuan.leophoneagent.relay.RelayBodyKeepAlive.enqueue(app)
                    AppLogger.info("BootCompletedReceiver", "relay body revived at boot")
                }
            } catch (t: Throwable) {
                AppLogger.warning("BootCompletedReceiver", "relay body revive failed: ${t.message}")
            } finally {
                pending.finish()
            }
        }.start()
    }
}
