package com.leoyuan.leophoneagent.relay

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

sealed class EngineChunk {
    data class Delta(val text: String) : EngineChunk()
    data class Completed(val output: String) : EngineChunk()
    data class Failed(val message: String) : EngineChunk()
}

interface MinisSessionEngine {
    fun runTurn(sessionId: String, text: String, thinking: String?): Flow<EngineChunk>

    /**
     * why suspend：原先是同步方法，Android 实现里用
     * `runBlocking { withContext(Main) { … } }` 桥回主线程。而调用点
     * `MinisHarnessRouter.handle` 跑在 OkHttp WebSocket 的 reader 线程上
     * （`RelayOutboundClient.handleHttp`），于是远程发一次 stop/steer 就把整条
     * relay socket 的读线程阻塞到主线程空闲为止 —— 而"需要 stop"的时刻恰好
     * 是主线程忙于流式重组的时刻，ping/pong 因此得不到处理，服务端可能判死
     * 连接。改成 suspend 后由 router 自己的协程 scope 承接，读线程永不阻塞。
     */
    suspend fun stop(sessionId: String)
    suspend fun release(sessionId: String) = stop(sessionId)
}

data class HarnessHttpResult(
    val status: Int,
    val body: JSONObject,
    val stream: Flow<JSONObject>? = null,
)

/**
 * In-process LeoAgent harness for Android. Same paths as Mac `/leophone`,
 * but the only advertised harness is `minis` → the on-device agent.
 */
class MinisHarnessRouter(
    private val appVersion: String,
    private val engine: MinisSessionEngine,
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
    private val nowSeconds: () -> Double = { System.currentTimeMillis() / 1000.0 },
) {
    private val sessions = ConcurrentHashMap<String, MinisHarnessSession>()
    @Volatile private var eventSink: ((JSONObject) -> Unit)? = null

    fun setEventSink(sink: ((JSONObject) -> Unit)?) {
        eventSink = sink
    }

    fun handle(method: String, pathAndQuery: String, body: JSONObject?): HarnessHttpResult {
        val path = pathAndQuery.substringBefore('?')
        val query = pathAndQuery.substringAfter('?', "")
        return when {
            method == "GET" && path == "/health" -> ok(
                JSONObject()
                    .put("status", "ok")
                    .put("platform", "android")
                    .put("version", PROTOCOL_VERSION)
                    .put("server", "minis")
                    .put("app_version", appVersion),
            )
            method == "GET" && path == "/v1/capabilities" -> ok(
                JSONObject()
                    .put("object", "leoagent.capabilities")
                    .put("platform", "android")
                    .put("version", PROTOCOL_VERSION)
                    .put("server", "minis")
                    .put(
                        "features",
                        JSONObject()
                            .put("harness_sessions", true)
                            .put("resumable_events", true)
                            .put("approval_events", false)
                            .put("session_steering", true)
                            .put("session_digest", false)
                            .put("task_receipts", false)
                            .put("artifacts", false),
                    )
                    .put(
                        "harnesses",
                        JSONArray().put(
                            JSONObject().put("key", "minis").put("name", "LeoPhoneAgent"),
                        ),
                    ),
            )
            method == "GET" && path == "/harness/sessions" -> ok(
                JSONObject().put("sessions", JSONArray().apply {
                    sessions.values.forEach { put(it.summary()) }
                }),
            )
            method == "POST" && path == "/harness/sessions" -> create(body ?: JSONObject())
            method == "GET" && path.matches(EVENTS) -> {
                val id = EVENTS.matchEntire(path)?.groupValues?.get(1) ?: return notFound()
                val after = query.substringAfter("after=", "0").toIntOrNull() ?: 0
                val session = sessions[id] ?: return notFound()
                // why 410：事件表是有界环形缓冲（见 MinisHarnessSession），超出
                // 容量的旧事件会被丢弃。如果控制端要求的 after 落在已丢弃的区
                // 段里，静默地"从还剩下的最老一条开始发"会让它以为中间没有事件，
                // 拼出来的输出是残缺的。这里显式回 410 + 可用的最小水位，让控制
                // 端知道要按新的 after 重新订阅（或整体重拉一次快照）。
                val oldest = session.oldestRetainedWatermark()
                if (after < oldest) {
                    return HarnessHttpResult(
                        410,
                        JSONObject()
                            .put(
                                "error",
                                JSONObject().put(
                                    "message",
                                    "events up to seq=$oldest were evicted; re-subscribe with after=$oldest",
                                ),
                            )
                            .put("evicted_through", oldest)
                            .put("min_after", oldest),
                    )
                }
                HarnessHttpResult(200, JSONObject().put("streaming", true), session.subscribe(after))
            }
            method == "POST" && path.matches(SEND) -> {
                val id = SEND.matchEntire(path)?.groupValues?.get(1) ?: return notFound()
                send(id, body ?: JSONObject())
            }
            method == "POST" && path.matches(STOP) -> {
                val id = STOP.matchEntire(path)?.groupValues?.get(1) ?: return notFound()
                stop(id)
            }
            method == "POST" && path.matches(APPROVAL) -> {
                val id = APPROVAL.matchEntire(path)?.groupValues?.get(1) ?: return notFound()
                sessions[id] ?: return notFound()
                error(409, "No such pending approval")
            }
            else -> error(404, "No such route")
        }
    }

    fun eventsAfter(sessionId: String, after: Int): Flow<JSONObject> =
        sessions[sessionId]?.replay(after) ?: emptyFlow()

    private fun create(body: JSONObject): HarnessHttpResult {
        val harness = body.optString("harness").ifBlank { "minis" }
        if (harness != "minis") {
            return error(400, "unknown harness: $harness (this Android body only runs minis)")
        }
        val prompt = body.optString("prompt").takeIf { it.isNotBlank() }
        if (prompt != null && prompt.length > MAX_PROMPT_CHARS) return error(413, "prompt is too large")
        val thinking = body.optString("thinking").ifBlank { body.optString("effort") }.takeIf { it.isNotBlank() }
        val cwd = body.optString("cwd").ifBlank { "~" }
        if (cwd.length > MAX_CWD_CHARS) return error(400, "cwd is too long")
        if (sessions.size >= MAX_SESSIONS) {
            // why 两级淘汰：原来只淘汰终态会话，于是 64 个会话全是 running 时
            // 永远 429，而且一条事件都不释放（叠加事件表无上限增长就是 OOM）。
            // 第二级按 lastTouched 淘汰"长时间没有任何事件"的僵死会话——真正
            // 在流式输出的会话每来一条 delta 都会刷新 lastTouched，所以不会被
            // 误伤；只有卡死/控制端早已离线的会话才会落到这一档。
            val now = nowSeconds()
            val evictable = sessions.values
                .filter { it.status in TERMINAL_STATUSES }
                .minByOrNull { it.lastTouched }
                ?: sessions.values
                    .filter { now - it.lastTouched >= STALE_SESSION_SECONDS }
                    .minByOrNull { it.lastTouched }
                ?: return error(429, "too many active sessions")
            sessions.remove(evictable.sessionId, evictable)
            evictable.cancelTurn()?.cancel()
            // why launch：engine.release 现在是 suspend（见 MinisSessionEngine），
            // 且 create() 跑在 WS reader 线程上，绝不能在这里阻塞等待。
            scope.launch { runCatching { engine.release(evictable.sessionId) } }
        }
        val session = MinisHarnessSession(
            sessionId = "hs_" + UUID.randomUUID().toString().replace("-", "").take(16),
            cwd = cwd,
            nowSeconds = nowSeconds,
            eventSink = { event -> eventSink?.invoke(event) },
        )
        sessions[session.sessionId] = session
        session.emit(
            JSONObject()
                .put("event", "session.created")
                .put("harness", "minis")
                .put("name", "LeoPhoneAgent")
                .put("cwd", cwd),
        )
        session.status = if (prompt == null) "idle" else "running"
        if (prompt != null) startTurn(session, prompt, thinking)
        return HarnessHttpResult(
            202,
            JSONObject()
                .put("session_id", session.sessionId)
                .put("harness", "minis")
                .put("status", session.status),
        )
    }

    private fun send(sessionId: String, body: JSONObject): HarnessHttpResult {
        val session = sessions[sessionId] ?: return notFound()
        val text = body.optString("text")
        if (text.isBlank()) return error(400, "text is required")
        if (text.length > MAX_PROMPT_CHARS) return error(413, "text is too large")
        val thinking = body.optString("thinking").ifBlank { body.optString("effort") }.takeIf { it.isNotBlank() }
        // why 先 cancelTurn 再 stop：原来是 `engine.stop()` 然后 `startTurn()`，
        // 而 turnGeneration 只在 startTurn→beginTurn 里才自增。stop 与 startTurn
        // 之间存在几十毫秒的窗口（engine.stop 曾是 runBlocking），旧 turn 在这个
        // 窗口里发出的 Completed 会通过 emitForTurn 的 generation 校验，于是
        // relay 上会看到一条带着**旧输出**的 run.completed 并把会话置回 idle。
        // cancelTurn() 立刻把 generation 自增，旧 turn 的终态事件从此一律被丢弃。
        session.cancelTurn()?.cancel()
        startTurn(session, text, thinking, stopPreviousTurn = true)
        return ok(JSONObject().put("ok", true).put("seq", session.seq))
    }

    private fun stop(sessionId: String): HarnessHttpResult {
        val session = sessions[sessionId] ?: return notFound()
        session.cancelTurn()?.cancel()
        session.status = "cancelled"
        session.emit(JSONObject().put("event", "run.cancelled"))
        // why launch：engine.stop 是 suspend 且最终要跳到主线程；handle() 跑在
        // OkHttp WS reader 线程上，同步等待会阻塞整条 relay 连接的读循环。
        scope.launch { runCatching { engine.stop(sessionId) } }
        return ok(JSONObject().put("ok", true).put("status", session.status))
    }

    private fun startTurn(
        session: MinisHarnessSession,
        text: String,
        thinking: String?,
        stopPreviousTurn: Boolean = false,
    ) {
        val generation = session.beginTurn()
        session.status = "running"
        session.emit(JSONObject().put("event", "user.message").put("text", text))
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                // why 放进本 turn 的协程里：steer 时必须保证"先停掉旧 turn，再
                // 起新 turn"的顺序。engine.stop 改成 suspend 之后如果单独
                // launch 出去就与新 turn 竞争，这里串行 await 掉即可，同时依然
                // 不占用 WS reader 线程。
                if (stopPreviousTurn) runCatching { engine.stop(session.sessionId) }
                val output = StringBuilder()
                engine.runTurn(session.sessionId, text, thinking).collect { chunk ->
                    when (chunk) {
                        is EngineChunk.Delta -> {
                            if (output.length < MAX_OUTPUT_CHARS) {
                                output.append(chunk.text.take(MAX_OUTPUT_CHARS - output.length))
                            }
                            session.emitForTurn(
                                generation,
                                null,
                                JSONObject().put("event", "message.delta").put("delta", chunk.text),
                            )
                        }
                        is EngineChunk.Completed -> {
                            val completed = chunk.output.ifBlank { output.toString() }.take(MAX_OUTPUT_CHARS)
                            session.emitForTurn(
                                generation,
                                "idle",
                                JSONObject()
                                    .put("event", "run.completed")
                                    .put("output", completed)
                                    .put("usage", JSONObject()),
                            )
                        }
                        is EngineChunk.Failed -> {
                            session.emitForTurn(
                                generation,
                                "idle",
                                JSONObject()
                                    .put("event", "run.failed")
                                    .put("message", chunk.message),
                            )
                        }
                    }
                }
            } catch (_: CancellationException) {
                // stop/steer owns the visible terminal event.
            } catch (error: Throwable) {
                session.emitForTurn(
                    generation,
                    "idle",
                    JSONObject()
                        .put("event", "run.failed")
                        .put("message", error.message ?: "minis turn failed"),
                )
            }
        }
        session.attachTurn(generation, job)
        job.start()
    }

    /**
     * 丢弃这个 router 持有的全部会话状态。
     *
     * why：`RelayBodyService.restart` 在配置一变就换一个新 router，旧 router 的
     * sessions / 事件表 / 在飞的 turn 之前没有任何清理路径 —— 旧对象被
     * RelayOutboundClient 释放后，里面的协程仍在跑、事件表仍占着内存，直到进程
     * 结束。切一次中继地址就泄漏一份。
     */
    fun shutdown() {
        val snapshot = sessions.values.toList()
        sessions.clear()
        snapshot.forEach { session ->
            session.cancelTurn()?.cancel()
            scope.launch { runCatching { engine.release(session.sessionId) } }
        }
        eventSink = null
    }

    private fun ok(body: JSONObject) = HarnessHttpResult(200, body)
    private fun notFound() = error(404, "No such session")
    private fun error(status: Int, message: String) =
        HarnessHttpResult(status, JSONObject().put("error", JSONObject().put("message", message)))

    companion object {
        const val PROTOCOL_VERSION = "0.4.0"
        private const val MAX_SESSIONS = 64
        private val TERMINAL_STATUSES = setOf("idle", "cancelled", "completed", "failed")

        /**
         * 第二级淘汰门槛：会话超过这么久没有产生任何事件就算僵死，可以在
         * MAX_SESSIONS 打满时被回收。正常流式会话每条 delta 都刷新 lastTouched。
         */
        private const val STALE_SESSION_SECONDS = 15 * 60.0
        private const val MAX_PROMPT_CHARS = 64 * 1024
        private const val MAX_CWD_CHARS = 2 * 1024
        private const val MAX_OUTPUT_CHARS = 1024 * 1024
        private val EVENTS = Regex("^/harness/sessions/([^/]+)/events$")
        private val SEND = Regex("^/harness/sessions/([^/]+)/send$")
        private val STOP = Regex("^/harness/sessions/([^/]+)/stop$")
        private val APPROVAL = Regex("^/harness/sessions/([^/]+)/approval$")
    }
}

private class MinisHarnessSession(
    val sessionId: String,
    val cwd: String,
    private val nowSeconds: () -> Double,
    private val eventSink: (JSONObject) -> Unit,
) {
    @Volatile var status: String = "starting"
    @Volatile var seq: Int = 0
    @Volatile var lastTouched: Double = nowSeconds()
    @Volatile private var turnGeneration: Long = 0
    private var turnJob: Job? = null

    /**
     * 有界环形事件缓冲。
     *
     * why：每条 `message.delta` 都进这个表，一轮长回答几百上千条；原来是无上限
     * 的 MutableList，而会话本身在"64 个都 running"时又永远不会被淘汰，所以这是
     * 一条确定的 OOM 路径。这里改成按条数 + 粗略字符预算双重封顶的环形缓冲，
     * 被丢掉的区段用 [evictedThrough] 记水位，`/events?after=` 落在水位之下时
     * router 显式回 410（见 MinisHarnessRouter），而不是静默少发。
     *
     * 不变式：events 内的 seq 是连续的，`events[i].seq == evictedThrough + 1 + i`。
     * 这让 [eventsAfter] 可以直接算下标切片，不必在锁里 filter 整张表。
     */
    private val events = ArrayDeque<JSONObject>()
    private var evictedThrough: Int = 0
    private var retainedChars: Int = 0
    private val subscribers = mutableSetOf<Channel<JSONObject>>()

    fun emit(event: JSONObject) {
        val overflowed = mutableListOf<Channel<JSONObject>>()
        val enriched: JSONObject
        val seqSnapshot: Int
        synchronized(this) {
            seq += 1
            seqSnapshot = seq
            lastTouched = nowSeconds()
            // why 不再 `JSONObject(event.toString())` 深拷贝：每条事件都要序列化
            // 再反序列化一遍，在 delta 频率下是纯浪费。所有调用点都是现场 new
            // 出来的临时 JSONObject，没有第二个持有者，就地补字段即可。
            enriched = event
                .put("seq", seqSnapshot)
                .put("session_id", sessionId)
                .put("timestamp", lastTouched)
            events.addLast(enriched)
            retainedChars += approximateSize(enriched)
            // `size > 1` 保证最新一条永远留在表里：单条事件本身就超预算时
            // （例如一条超大 run.completed）不该把自己也丢掉。
            while (events.size > 1 &&
                (events.size > MAX_RETAINED_EVENTS || retainedChars > MAX_RETAINED_CHARS)
            ) {
                val dropped = events.removeFirst()
                retainedChars -= approximateSize(dropped)
                evictedThrough += 1
            }
            subscribers.forEach { channel ->
                if (channel.trySend(enriched).isFailure) overflowed += channel
            }
            subscribers.removeAll(overflowed.toSet())
        }
        overflowed.forEach {
            it.close(IllegalStateException("subscriber overflow; reconnect with after=$seqSnapshot"))
        }
        val name = enriched.optString("event")
        if (name in PUSH_EVENTS) eventSink(enriched)
    }

    /** 已被环形缓冲丢弃的最大 seq。控制端必须用 `after >= 这个值` 重新订阅。 */
    @Synchronized
    fun oldestRetainedWatermark(): Int = evictedThrough

    /**
     * 取 seq > [after] 的事件快照。依赖上面的连续性不变式做下标切片，
     * 避免在会话锁里遍历整张表（P2：replay/subscribe 曾各自 filter 一遍）。
     */
    @Synchronized
    private fun eventsAfter(after: Int): List<JSONObject> {
        val startIdx = (after - evictedThrough).coerceAtLeast(0)
        if (startIdx >= events.size) return emptyList()
        return events.drop(startIdx)
    }

    /** 只算 delta/output 的正文长度 + 固定开销，避免为记账再 toString 一遍。 */
    private fun approximateSize(event: JSONObject): Int =
        event.optString("delta").length + event.optString("output").length +
            event.optString("text").length + event.optString("message").length +
            EVENT_OVERHEAD_CHARS

    @Synchronized
    fun beginTurn(): Long {
        turnGeneration += 1
        turnJob?.cancel()
        turnJob = null
        return turnGeneration
    }

    @Synchronized
    fun attachTurn(generation: Long, job: Job) {
        if (turnGeneration == generation) turnJob = job else job.cancel()
    }

    @Synchronized
    fun cancelTurn(): Job? {
        turnGeneration += 1
        return turnJob.also { turnJob = null }
    }

    /**
     * why 不再整体 `@Synchronized`：`emit` 的最后一步是 `eventSink(...)`，那是
     * 一次 WebSocket 写。原来 emitForTurn 是同步方法，于是这次网络写始终在持有
     * 会话锁的状态下发生 —— 同会话的 subscribe/replay/summary 全部被网络 IO 卡住。
     * 这里把"generation 校验 + 状态迁移"留在锁内（它们才是真正需要原子性的
     * 部分），emit 本身移到锁外；emit 内部对事件表另有自己的短临界区。
     */
    fun emitForTurn(generation: Long, nextStatus: String?, event: JSONObject): Boolean {
        synchronized(this) {
            if (turnGeneration != generation) return false
            if (nextStatus != null) status = nextStatus
        }
        emit(event)
        return true
    }

    fun replay(after: Int): Flow<JSONObject> {
        val snapshot = eventsAfter(after)
        return flow {
            snapshot.forEach { emit(it) }
        }
    }

    fun subscribe(after: Int): Flow<JSONObject> = flow {
        val channel = Channel<JSONObject>(capacity = LIVE_BUFFER)
        val snapshot = synchronized(this@MinisHarnessSession) {
            subscribers += channel
            val startIdx = (after - evictedThrough).coerceAtLeast(0)
            if (startIdx >= events.size) emptyList() else events.drop(startIdx)
        }
        var seen = after
        try {
            snapshot.forEach { event ->
                seen = maxOf(seen, event.optInt("seq"))
                emit(event)
            }
            for (event in channel) {
                val eventSeq = event.optInt("seq")
                if (eventSeq > seen) {
                    seen = eventSeq
                    emit(event)
                }
            }
        } finally {
            synchronized(this@MinisHarnessSession) { subscribers.remove(channel) }
            channel.close()
        }
    }

    @Synchronized
    fun summary(): JSONObject = JSONObject()
        .put("session_id", sessionId)
        .put("harness", "minis")
        .put("name", "LeoPhoneAgent")
        .put("cwd", cwd)
        .put("status", status)
        .put("seq", seq)
        .put("waiting_for_approval", false)
        .put("pending_approvals", JSONArray())

    companion object {
        /**
         * 单个订阅者的在途缓冲。fail-closed（溢出即断流、让控制端带 after 重连）
         * 的设计是对的，但 64 在 delta 频率下太容易触发：一次网络抖动就足以让
         * 控制端断流重连，反而更糟。放大到 512，仍然有界。
         */
        private const val LIVE_BUFFER = 512

        /** 环形缓冲条数上限。 */
        private const val MAX_RETAINED_EVENTS = 2000

        /** 环形缓冲字符预算（约 2 MB 正文），防止少量超大事件撑爆内存。 */
        private const val MAX_RETAINED_CHARS = 2 * 1024 * 1024

        /** 每条事件除正文外的固定记账开销（seq/session_id/timestamp/event 名）。 */
        private const val EVENT_OVERHEAD_CHARS = 96

        private val PUSH_EVENTS = setOf(
            "approval.request",
            "run.completed",
            "run.failed",
            "run.cancelled",
            "artifact.ready",
        )
    }
}
