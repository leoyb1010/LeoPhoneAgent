package com.leoyuan.leophoneagent.relay

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.leoyuan.leophoneagent.logging.AppLogger
import com.leoyuan.leophoneagent.service.RelayBodyForegroundService
import java.util.concurrent.TimeUnit

/**
 * 周期兜底，用来把「Android 身体」从死掉的状态里捞回来。
 *
 * why（review P1#12 的第二半）：常驻前台服务解决了"turn 结束就掉 cached"，
 * 但它自己也会被系统/OEM 清理掉（任务卡片划掉、内存压力、厂商省电策略）。
 * 一旦它没了，进程就再也不会自己起来 —— 能拉起它的事件恰恰是"收到远程任务"，
 * 而收任务需要进程活着。WorkManager 的周期任务是唯一不依赖"进程还活着"的
 * 唤醒源：JobScheduler 记在系统侧，进程被杀也会到点把它拉起来。
 *
 * 15 分钟是 [PeriodicWorkRequest] 的最小周期（`MIN_PERIODIC_INTERVAL_MILLIS`）。
 *
 * 注意 `startForegroundService` 在这里是**尽力而为**：普通 Worker 的执行上下文
 * 在 Android 12+ 并不天然享有后台启动前台服务的豁免，
 * [RelayBodyForegroundService.start] 已经把异常吞掉并返回 false。
 * 拿不到前台服务时，至少 [RelayBodyService.start] 还能把进程内的中继连接
 * 重新拉起来，撑到用户下一次打开 App 或系统给出机会为止。
 */
object RelayBodyKeepAlive {
    private const val UNIQUE = "leo-relay-body-keepalive"
    private const val TAG = "RelayBodyKeepAlive"

    fun enqueue(context: Context) {
        runCatching {
            val request = PeriodicWorkRequestBuilder<RelayBodyKeepAliveWorker>(
                15, TimeUnit.MINUTES,
            ).setConstraints(
                // 没网的时候把身体拉起来没有意义，只会白耗电。
                Constraints.Builder()
                    .setRequiredNetworkType(androidx.work.NetworkType.CONNECTED)
                    .build(),
            ).build()
            WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
                UNIQUE,
                // KEEP：已经排上的周期任务不要每次配置变化都重排，
                // 否则 15 分钟的计时会被无限推迟。
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }.onFailure { AppLogger.warning(TAG, "enqueue failed: ${it.message}") }
    }

    fun cancel(context: Context) {
        runCatching {
            WorkManager.getInstance(context.applicationContext).cancelUniqueWork(UNIQUE)
        }.onFailure { AppLogger.warning(TAG, "cancel failed: ${it.message}") }
    }
}

class RelayBodyKeepAliveWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        return try {
            // 幂等：连接已经活着时 start() 直接返回。
            RelayBodyService.start(applicationContext)
            if (RelayBodyService.isBodyEnabled(applicationContext)) {
                RelayBodyForegroundService.start(applicationContext)
            }
            Result.success()
        } catch (t: Throwable) {
            AppLogger.warning("RelayBodyKeepAlive", "worker failed: ${t.message}")
            Result.success()
        }
    }
}
