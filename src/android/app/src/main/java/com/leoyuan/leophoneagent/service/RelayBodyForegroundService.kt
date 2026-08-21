package com.leoyuan.leophoneagent.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.leoyuan.leophoneagent.MainActivity
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.relay.RelayBodyService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * 常驻前台服务：让「Android 身体」在没有任何聊天会话在跑的时候也活着。
 *
 * why 这个服务必须存在（review P1#12）：
 *   `relay/RelayBodyService` 只是个 Kotlin `object`，整个 relay 包里既没有
 *   前台服务也没有 WakeLock。turn 一结束 [AgentForegroundService] 就被拆掉，
 *   进程掉进 cached，Doze 一到连接就断 —— 而且**没有复活路径**：能把
 *   [AgentForegroundService] 拉起来的事件是"收到远程任务"，可要收到任务，
 *   进程得先活着。这是个死结。
 *
 * 解开死结的办法只有一个：只要用户打开了「允许本机接受远程任务」，就常驻一个
 * 与聊天无关的前台服务，把进程钉在 foreground service 的 proc state 上。
 * 顺带还修掉了 P0#1 的根因 —— 进程已经持有可见前台服务时，
 * `startForegroundService` 不再受 Android 12+ 的后台启动限制。
 *
 * 前台服务类型选 `remoteMessaging`：
 *   * 语义最贴切（本机在为"来自其他设备的消息/任务"保持连接）；
 *   * 没有 `dataSync` 的 6h/24h 累计上限；
 *   * Android 14 对 BOOT_COMPLETED 拉起的 FGS 类型做了收紧，
 *     `dataSync / camera / mediaPlayback / microphone / …` 都不允许，
 *     `remoteMessaging` 允许 —— 开机复活路径需要它。
 */
class RelayBodyForegroundService : Service() {

    private var wakeLock: PowerManager.WakeLock? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var wakeLockRenewJob: Job? = null
    private var onlineJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        // 与 AgentForegroundService 一致的安全模式短路：崩溃频次探测器一旦
        // 跳闸就什么重活都不做，只满足 startForeground 的 5 秒契约再退出。
        if (com.leoyuan.leophoneagent.crash.CrashFrequencyDetector.isSafeMode()) {
            createChannel()
            return
        }
        createChannel()
        acquireWakeLock()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (com.leoyuan.leophoneagent.crash.CrashFrequencyDetector.isSafeMode()) {
            runCatching { startForegroundCompat(buildNotification(online = false)) }
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        // startForeground 必须在 5 秒内调用，放在任何其它工作之前。
        startForegroundCompat(buildNotification(online = RelayBodyService.isOnline()))
        // 幂等：如果进程是被系统重建（START_STICKY，intent == null）的，
        // Application.onCreate 里的 start 也已经跑过一次，这里再调一次没有副作用。
        runCatching { RelayBodyService.start(applicationContext) }
            .onFailure { Log.w(TAG, "RelayBodyService.start failed: ${it.message}") }
        observeOnlineState()
        // START_STICKY：进程被系统回收后重建服务，是复活链路的一环。
        return START_STICKY
    }

    override fun onDestroy() {
        wakeLockRenewJob?.cancel()
        wakeLockRenewJob = null
        onlineJob?.cancel()
        onlineJob = null
        releaseWakeLock()
        scope.cancel()
        super.onDestroy()
    }

    /** 在线状态变化时刷新通知文案，让用户能一眼看出中继是不是真的连上了。 */
    private fun observeOnlineState() {
        if (onlineJob?.isActive == true) return
        onlineJob = scope.launch {
            RelayBodyService.online.collect { online ->
                runCatching {
                    getSystemService(NotificationManager::class.java)
                        ?.notify(NOTIFICATION_ID, buildNotification(online))
                }
            }
        }
    }

    private fun startForegroundCompat(notification: Notification) {
        try {
            // FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING 是 API 34 才加入的常量。
            // Android 13 及以下必须走两参重载；若把这个 type 位传给旧系统，
            // 会被当成未知前台服务类型并拒绝启动。Android 14+ 才显式传入。
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (t: Throwable) {
            // 同 P0#1：绝不让 startForeground 的失败变成进程崩溃。
            Log.w(TAG, "startForeground failed: ${t.message}")
            stopSelf()
        }
    }

    private fun buildNotification(online: Boolean): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.relay_body_notification_title))
            .setContentText(
                getString(
                    if (online) R.string.relay_body_notification_text
                    else R.string.relay_body_notification_offline,
                ),
            )
            // 与 AgentForegroundService 一致，用平台自带图标，不额外引入 drawable。
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.relay_body_channel_name),
            NotificationManager.IMPORTANCE_MIN,
        ).apply {
            description = getString(R.string.relay_body_channel_description)
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    /**
     * why 要续期：`acquire(timeout)` 到期后锁自动释放且**不会**再自己续。
     * [AgentForegroundService] 里那把 6 小时的锁就是只在 onCreate 调了一次
     * （review P1#13）—— 而 manifest 之所以从 dataSync 换成 mediaPlayback，
     * 全部理由就是"要跑超过 6 小时"。这里同样用"带超时 + 周期续期"的写法：
     * 超时是进程异常退出时的兜底，续期保证正常情况下不会中途松手。
     */
    private fun acquireWakeLock() {
        if (wakeLock != null) return
        runCatching {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "minis:relay-body").apply {
                setReferenceCounted(false)
                acquire(WAKELOCK_TIMEOUT_MS)
            }
        }.onFailure { Log.w(TAG, "wakelock acquire failed: ${it.message}") }
        wakeLockRenewJob = scope.launch {
            while (isActive) {
                delay(WAKELOCK_RENEW_INTERVAL_MS)
                runCatching { wakeLock?.acquire(WAKELOCK_TIMEOUT_MS) }
                    .onFailure { Log.w(TAG, "wakelock renew failed: ${it.message}") }
            }
        }
    }

    private fun releaseWakeLock() {
        runCatching { wakeLock?.takeIf { it.isHeld }?.release() }
            .onFailure { Log.w(TAG, "wakelock release failed: ${it.message}") }
        wakeLock = null
    }

    companion object {
        private const val TAG = "RelayBodyFgs"
        private const val CHANNEL_ID = "relay_body_status"
        private const val NOTIFICATION_ID = 9101
        const val ACTION_STOP = "com.leoyuan.leophoneagent.STOP_RELAY_BODY"

        /** WakeLock 超时兜底：进程异常时最多多持有这么久。 */
        private const val WAKELOCK_TIMEOUT_MS = 60L * 60L * 1000L

        /** 续期间隔，取超时的一半，留足重叠窗口。 */
        private const val WAKELOCK_RENEW_INTERVAL_MS = 30L * 60L * 1000L

        /**
         * 拉起常驻身体服务。**永不抛异常**：
         * Android 12+ 在后台调用 `startForegroundService` 会抛
         * `ForegroundServiceStartNotAllowedException`，而这个方法的调用点里
         * 就有 WorkManager 周期任务和 BOOT_COMPLETED 广播这类后台上下文。
         *
         * @return true 表示系统接受了这次启动请求。
         */
        fun start(context: Context): Boolean = try {
            val intent = Intent(context.applicationContext, RelayBodyForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.applicationContext.startForegroundService(intent)
            } else {
                context.applicationContext.startService(intent)
            }
            true
        } catch (t: Throwable) {
            Log.w(TAG, "start refused by system: ${t.javaClass.simpleName}: ${t.message}")
            false
        }

        fun stop(context: Context) {
            runCatching {
                context.applicationContext.stopService(
                    Intent(context.applicationContext, RelayBodyForegroundService::class.java),
                )
            }.onFailure { Log.w(TAG, "stop failed: ${it.message}") }
        }
    }
}
