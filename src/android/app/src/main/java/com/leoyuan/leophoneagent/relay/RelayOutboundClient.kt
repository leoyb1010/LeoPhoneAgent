package com.leoyuan.leophoneagent.relay

import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
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
    private var socket: WebSocket? = null
    private var loopJob: Job? = null
    private val _online = MutableStateFlow(false)
    val online: StateFlow<Boolean> = _online.asStateFlow()

    fun start(scope: CoroutineScope) {
        if (loopJob?.isActive == true) return
        stopped.set(false)
        loopJob = scope.launch(Dispatchers.IO) {
            var backoff = 1L
            while (!stopped.get()) {
                try {
                    connectOnce()
                    backoff = 1L
                } catch (error: Throwable) {
                    Log.w(TAG, "disconnected: ${error.message}")
                    _online.value = false
                }
                if (stopped.get()) break
                delay(backoff * 1000)
                backoff = (backoff * 2).coerceAtMost(30)
            }
        }
    }

    fun stop() {
        stopped.set(true)
        streams.values.forEach { it.cancel() }
        streams.clear()
        socket?.close(1000, "stop")
        socket = null
        loopJob?.cancel()
        loopJob = null
        _online.value = false
    }

    /** One connection cycle. Exported for tests. */
    fun connectOnce() {
        val latch = java.util.concurrent.CountDownLatch(1)
        val failure = arrayOfNulls<Throwable>(1)
        val request = Request.Builder().url(config.wsUrl).build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                socket = webSocket
                webSocket.send(
                    RelayOutboundCodec.registerFrame(config.name, config.relayKey, config.version).toString(),
                )
                _online.value = true
                Log.i(TAG, "connected to relay as ${config.name}")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = RelayOutboundCodec.parse(text) ?: return
                when (frame.optString("type")) {
                    "http" -> handleHttp(webSocket, frame)
                    "stream_open" -> handleStream(webSocket, frame)
                    "stream_cancel" -> streams.remove(frame.optString("id"))?.cancel()
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
        http.newWebSocket(request, listener)
        latch.await()
        failure[0]?.let { throw it }
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
        val path = frame.optString("path", "/")
        val jobScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val job = jobScope.launch {
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
                streams.remove(streamId)
                send(ws, RelayOutboundCodec.streamClose(streamId))
                jobScope.cancel()
            }
        }
        streams[streamId] = job
    }

    private fun send(ws: WebSocket, frame: JSONObject) {
        ws.send(frame.toString())
    }

    companion object {
        private const val TAG = "RelayOutbound"
        private fun defaultClient() = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)
            .build()
    }
}
