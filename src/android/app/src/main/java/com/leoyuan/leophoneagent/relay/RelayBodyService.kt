package com.leoyuan.leophoneagent.relay

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Log
import com.leoyuan.leophoneagent.BuildConfig
import com.leoyuan.leophoneagent.network.NetworkMonitor
import com.leoyuan.leophoneagent.offload.OffloadPermissionManager
import com.leoyuan.leophoneagent.service.RelayBodyForegroundService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Starts the outbound relay body when a fleet key is saved. Both flavors. */
object RelayBodyService {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var client: RelayOutboundClient? = null
    @Volatile private var router: MinisHarnessRouter? = null
    @Volatile private var startedFor: String? = null
    @Volatile private var started = false
    private var onlineMirrorJob: Job? = null
    private var networkJob: Job? = null

    private val _online = MutableStateFlow(false)

    /** 中继连接是否已注册成功。给常驻前台服务的通知文案用。 */
    val online: StateFlow<Boolean> = _online.asStateFlow()

    fun isOnline(): Boolean = _online.value

    /**
     * 用户是否打开了「允许本机接受远程任务」且密钥有效。
     * 供 keep-alive worker / 开机广播这类"进程刚被拉起、还没走过 restart"
     * 的上下文判断要不要拉常驻服务。读的是加密存储，调用方需在 IO 上下文。
     */
    fun isBodyEnabled(context: Context): Boolean = runCatching {
        val config = RelayFleetStore.get(context.applicationContext).config.value
        config.bodyEnabled && config.accessKey.length >= 16
    }.getOrDefault(false)

    fun start(context: Context) {
        val app = context.applicationContext
        synchronized(this) {
            if (started) return
            started = true
        }
        scope.launch {
            // why 放进 scope.launch：`RelayFleetStore.get(app)` 会在调用线程上跑
            // `EncryptedSharedPreferences.create` —— 一次 Keystore 解包 + 磁盘 IO。
            // 这个方法由 `MinisApp.onCreate` 在主线程调用，等于把冷启动路径上
            // 又压了一段 Keystore/IO（README 点名在意 Fold8 冷启动）。
            val store = runCatching { RelayFleetStore.get(app) }
                .onFailure {
                    Log.w(TAG, "relay store unavailable: ${it.message}")
                    // 放掉一次性闸门，让 keep-alive worker / 前台服务还能再试。
                    synchronized(RelayBodyService) { started = false }
                }
                .getOrNull() ?: return@launch
            observeNetwork(app)
            // StateFlow already suppresses equal consecutive values.
            store.config.collect { config ->
                restart(app, store, config)
            }
        }
    }

    /**
     * 网络恢复时立刻重连，而不是干等最长 30 秒的退避。
     *
     * why：`network/NetworkMonitor` 早就存在，但 relay 一直没接。切一次网
     * （Wi-Fi ↔ 蜂窝）之后，叠加 25 秒 pingInterval，最坏 55–80 秒不可达。
     */
    private fun observeNetwork(app: Context) {
        if (networkJob?.isActive == true) return
        val monitor = (app as? com.leoyuan.leophoneagent.MinisApp)?.networkMonitor ?: return
        networkJob = scope.launch {
            monitor.status.collect { status ->
                if (status == NetworkMonitor.NetworkStatus.CONNECTED) {
                    client?.retryNow()
                }
            }
        }
    }

    @Synchronized
    private fun restart(app: Context, store: RelayFleetStore, config: RelayFleetConfig) {
        val key = config.accessKey
        val enabled = key.length >= 16 && config.bodyEnabled
        // 隐私提级开关：远程可驱动本机 Agent 时，PRIVACY 组工具的有效等级
        // 强制提到 ASK_ONCE（见 OffloadPermissionManager.setRemoteBodyEnabled）。
        OffloadPermissionManager.setRemoteBodyEnabled(enabled)
        if (!enabled) {
            teardown()
            RelayBodyForegroundService.stop(app)
            RelayBodyKeepAlive.cancel(app)
            return
        }
        val name = store.ensureMachineName(defaultMachineName(app))
        val token = "${config.relayApiBase}|$key|$name"
        if (startedFor == token && client != null) {
            // 配置没变，但常驻服务可能已被系统回收 —— 幂等地再拉一次。
            RelayBodyForegroundService.start(app)
            return
        }
        teardown()
        val nextRouter = MinisHarnessRouter(
            appVersion = BuildConfig.VERSION_NAME,
            engine = AndroidMinisSessionEngine(app),
            scope = scope,
        )
        val next = RelayOutboundClient(
            RelayOutboundConfig(
                wsUrl = RelayOutboundCodec.agentWsUrl(config.relayApiBase),
                relayKey = key,
                name = name,
                version = BuildConfig.VERSION_NAME,
            ),
            nextRouter,
        )
        nextRouter.setEventSink(next::pushEvent)
        client = next
        router = nextRouter
        startedFor = token
        next.start(scope)
        onlineMirrorJob = scope.launch { next.online.collect { _online.value = it } }
        // 常驻前台服务 + WorkManager 周期兜底：把"进程活着"从"恰好有会话在跑"
        // 里解耦出来（review P1#12 的死结）。
        RelayBodyForegroundService.start(app)
        RelayBodyKeepAlive.enqueue(app)
        Log.i(TAG, "android body registering as $name")
    }

    /**
     * 释放上一代 client/router。
     *
     * why：原来只 `client?.stop()`，旧 router 的 sessions / 事件表 / 在飞 turn
     * 完全没有清理路径（P2#19）—— 切一次中继地址就泄漏一份，而事件表在长会话
     * 下能到 MB 级。
     */
    private fun teardown() {
        onlineMirrorJob?.cancel()
        onlineMirrorJob = null
        client?.stop()
        client = null
        router?.shutdown()
        router = null
        startedFor = null
        _online.value = false
    }

    fun defaultMachineName(context: Context): String {
        val device = runCatching {
            Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
        }.getOrNull().orEmpty().ifBlank { Build.MODEL }
        return device.trim().replace(Regex("\\s+"), "-").ifBlank { "android-body" }
    }

    private const val TAG = "RelayBody"
}
