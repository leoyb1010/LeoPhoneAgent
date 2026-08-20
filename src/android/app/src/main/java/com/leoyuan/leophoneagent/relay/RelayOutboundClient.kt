package com.leoyuan.leophoneagent.relay

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

data class RelayOutboundConfig(
    val wsUrl: String,
    val relayKey: String,
    val name: String,
    val version: String,
)

/**
 * Dual of Mac `LeophoneRelayClient`: outbound WS register, then in-process
 * minis harness instead of localhost HTTP.
 */
class RelayOutboundClient(
    private val config: RelayOutboundConfig,
    private val router: MinisHarnessRouter,
    private val http: OkHttpClient = defaultClient(),
) {
    private val stopped = AtomicBoolean(false)
    private val streams = ConcurrentHashMap<String, Job>()
    private val outbox = ArrayDeque<JSONObject>()
    private var socket: WebSocket? = null
    private var loopJob: Job? = null
    private val _online = MutableStateFlow(false)
    val online: StateFlow<Boolean> = _online.asStateFlow()

    /**
     * 重连退避（秒）。
     *
     * why 提到字段并且由 `registered` 帧复位：原来 `backoff` 是 [start] 循环里的
     * 局部变量，靠 `connectOnce()` 正常返回来复位。但 `connectOnce` 在 `onClosed`
     * **和** `onFailure` 里都写 `failure[0]` 然后抛出 —— 服务端优雅关闭同样走抛
     * 异常路径，于是 `backoff = 1L` 那行只有 stop 路径可达。结果是：切几次网之后
     * 退避永久卡在 30 秒，叠加 25 秒的 pingInterval，一次切网最长 55–80 秒不可达。
     * 现在只要真正握手成功（收到 registered）就复位。
     */
    private val backoffSeconds = java.util.concurrent.atomic.AtomicLong(1L)

    /**
     * 外部"立刻重连"信号（网络恢复时由 [RelayBodyService] 触发）。CONFLATED：
     * 短时间内多次网络回调只需要唤醒一次。
     */
    private val reconnectSignal = kotlinx.coroutines.channels.Channel<Unit>(
        kotlinx.coroutines.channels.Channel.CONFLATED,
    )

    fun start(scope: CoroutineScope) {
        if (loopJob?.isActive == true) return
        stopped.set(false)
        backoffSeconds.set(1L)
        loopJob = scope.launch(Dispatchers.IO) {
            while (!stopped.get()) {
                try {
                    connectOnce()
                } catch (error: Throwable) {
                    Log.w(TAG, "disconnected: ${error.message}")
                    _online.value = false
                }
                if (stopped.get()) break
                val waitMs = backoffSeconds.get() * 1000
                // 退避期间可被 retryNow() 提前唤醒；否则睡满再翻倍。
                val woken = kotlinx.coroutines.withTimeoutOrNull(waitMs) {
                    reconnectSignal.receive()
                } != null
                if (!woken) {
                    backoffSeconds.set((backoffSeconds.get() * 2).coerceAtMost(MAX_BACKOFF_SECONDS))
                }
            }
        }
    }

    /**
     * 网络恢复（或用户手动重试）时立刻重连：复位退避、打断当前退避等待，并把
     * 一条已经死掉的 socket 掐断，让 [connectOnce] 从 `latch.await()` 里返回。
     *
     * why：Android 侧本来就有 `network/NetworkMonitor`，但 relay 一直没用它。
     * 切网后只能干等退避，最坏 30 秒。
     */
    fun retryNow() {
        if (stopped.get()) return
        backoffSeconds.set(1L)
        reconnectSignal.trySend(Unit)
        if (!_online.value) {
            synchronized(this) { socket?.cancel() }
        }
    }

    @Synchronized
    fun stop() {
        stopped.set(true)
        streams.values.forEach { it.cancel() }
        streams.clear()
        // cancel() also aborts an in-flight HTTP upgrade. A graceful close only
        // works after onOpen and could let a stale-key client register later.
        socket?.cancel()
        socket = null
        loopJob?.cancel()
        loopJob = null
        _online.value = false
    }

    fun pushEvent(event: JSONObject) {
        val frame = RelayOutboundCodec.event(config.name, event)
        synchronized(outbox) {
            val ws = socket
            if (ws != null && _online.value && ws.send(frame.toString())) return
            outbox.addLast(frame)
            while (outbox.size > OUTBOX_LIMIT) outbox.removeFirst()
        }
    }

    /** One connection cycle. Exported for tests. */
    fun connectOnce() {
        val latch = java.util.concurrent.CountDownLatch(1)
        val failure = arrayOfNulls<Throwable>(1)
        val request = Request.Builder().url(config.wsUrl).build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                synchronized(this@RelayOutboundClient) {
                    if (stopped.get()) {
                        webSocket.cancel()
                        latch.countDown()
                        return
                    }
                    socket = webSocket
                    webSocket.send(
                        RelayOutboundCodec.registerFrame(config.name, config.relayKey, config.version).toString(),
                    )
                }
                Log.i(TAG, "relay socket open; registering as ${config.name}")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = RelayOutboundCodec.parse(text) ?: return
                when (frame.optString("type")) {
                    "registered" -> {
                        _online.value = true
                        // 真正握手成功才复位退避（见 backoffSeconds 的注释）。
                        backoffSeconds.set(1L)
                        flushOutbox(webSocket)
                        Log.i(TAG, "registered with relay as ${config.name}")
                    }
                    "http" -> handleHttp(webSocket, frame)
                    "stream_open" -> handleStream(webSocket, frame)
                    "stream_cancel" -> {
                        val id = frame.optString("id")
                        streams.remove(id)?.let {
                            it.cancel()
                            send(webSocket, RelayOutboundCodec.streamClose(id))
                        }
                    }
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                _online.value = false
                failure[0] = IllegalStateException("relay closed ($code $reason)")
                latch.countDown()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                _online.value = false
                failure[0] = t
                latch.countDown()
            }
        }
        val connecting = http.newWebSocket(request, listener)
        socket = connecting
        if (stopped.get()) {
            connecting.cancel()
            latch.countDown()
        }
        try {
            latch.await()
            failure[0]?.let { throw it }
        } finally {
            synchronized(this) {
                if (socket === connecting) socket = null
            }
            cancelStreams()
        }
    }

    private fun handleHttp(ws: WebSocket, frame: JSONObject) {
        val id = frame.opt("id")
        val method = frame.optString("method", "GET").uppercase()
        val path = frame.optString("path", "/")
        val body = frame.optJSONObject("body")
        try {
            val result = router.handle(method, path, body)
            send(ws, RelayOutboundCodec.resp(id, result.status, result.body))
        } catch (error: Throwable) {
            send(
                ws,
                RelayOutboundCodec.resp(
                    id,
                    502,
                    JSONObject().put(
                        "error",
                        JSONObject().put("message", "local call failed: ${error.message}"),
                    ),
                ),
            )
        }
    }

    private fun handleStream(ws: WebSocket, frame: JSONObject) {
        val streamId = frame.optString("id")
        if (streamId.isBlank()) return
        val path = frame.optString("path", "/")
        val jobScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val job = jobScope.launch(start = CoroutineStart.LAZY) {
            try {
                val result = router.handle("GET", path, null)
                if (result.stream == null) {
                    send(ws, RelayOutboundCodec.resp(streamId, result.status, result.body))
                    return@launch
                }
                result.stream.collect { event ->
                    send(ws, RelayOutboundCodec.streamData(streamId, event.toString()))
                }
            } catch (error: Throwable) {
                if (error !is kotlinx.coroutines.CancellationException) {
                    Log.w(TAG, "stream $streamId error: ${error.message}")
                }
            } finally {
                val owned = coroutineContext[Job]?.let { streams.remove(streamId, it) } == true
                if (owned) send(ws, RelayOutboundCodec.streamClose(streamId))
                jobScope.cancel()
            }
        }
        streams.put(streamId, job)?.cancel()
        job.start()
    }

    private fun send(ws: WebSocket, frame: JSONObject) {
        ws.send(frame.toString())
    }

    private fun flushOutbox(ws: WebSocket) {
        synchronized(outbox) {
            while (outbox.isNotEmpty()) {
                val frame = outbox.first()
                if (!ws.send(frame.toString())) return
                outbox.removeFirst()
            }
        }
    }

    private fun cancelStreams() {
        streams.values.forEach { it.cancel() }
        streams.clear()
    }

    companion object {
        private const val TAG = "RelayOutbound"
        private const val OUTBOX_LIMIT = 200
        private const val MAX_BACKOFF_SECONDS = 30L
        private fun defaultClient() = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .build()
    }
}
