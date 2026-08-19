package com.leoyuan.leophoneagent.relay

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Log
import com.leoyuan.leophoneagent.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Starts the outbound relay body when a fleet key is saved. Both flavors. */
object RelayBodyService {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var client: RelayOutboundClient? = null
    @Volatile private var startedFor: String? = null

    fun start(context: Context) {
        val app = context.applicationContext
        val store = RelayFleetStore(app)
        scope.launch {
            // StateFlow already suppresses equal consecutive values.
            store.config.collect { config ->
                restart(app, store, config)
            }
        }
    }

    @Synchronized
    private fun restart(app: Context, store: RelayFleetStore, config: RelayFleetConfig) {
        val key = config.accessKey
        if (key.length < 16 || !config.bodyEnabled) {
            client?.stop()
            client = null
            startedFor = null
            return
        }
        val name = store.ensureMachineName(defaultMachineName(app))
        val token = "${config.relayApiBase}|$key|$name"
        if (startedFor == token && client != null) return
        client?.stop()
        val router = MinisHarnessRouter(
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
            router,
        )
        client = next
        startedFor = token
        next.start(scope)
        Log.i(TAG, "android body registering as $name")
    }

    fun defaultMachineName(context: Context): String {
        val device = runCatching {
            Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
        }.getOrNull().orEmpty().ifBlank { Build.MODEL }
        return device.trim().replace(Regex("\\s+"), "-").ifBlank { "android-body" }
    }

    private const val TAG = "RelayBody"
}
