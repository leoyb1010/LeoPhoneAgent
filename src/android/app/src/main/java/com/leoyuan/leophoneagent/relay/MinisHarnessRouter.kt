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
    fun stop(sessionId: String)
    fun release(sessionId: String) = stop(sessionId)
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
            val evictable = sessions.values
                .filter { it.status in setOf("idle", "cancelled", "completed", "failed") }
                .minByOrNull { it.lastTouched }
                ?: return error(429, "too many active sessions")
            sessions.remove(evictable.sessionId, evictable)
            evictable.cancelTurn()?.cancel()
            engine.release(evictable.sessionId)
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
        engine.stop(session.sessionId)
        startTurn(session, text, thinking)
        return ok(JSONObject().put("ok", true).put("seq", session.seq))
    }

    private fun stop(sessionId: String): HarnessHttpResult {
        val session = sessions[sessionId] ?: return notFound()
        session.cancelTurn()?.cancel()
        engine.stop(sessionId)
        session.status = "cancelled"
        session.emit(JSONObject().put("event", "run.cancelled"))
        return ok(JSONObject().put("ok", true).put("status", session.status))
    }

    private fun startTurn(session: MinisHarnessSession, text: String, thinking: String?) {
        val generation = session.beginTurn()
        session.status = "running"
        session.emit(JSONObject().put("event", "user.message").put("text", text))
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
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

    private fun ok(body: JSONObject) = HarnessHttpResult(200, body)
    private fun notFound() = error(404, "No such session")
    private fun error(status: Int, message: String) =
        HarnessHttpResult(status, JSONObject().put("error", JSONObject().put("message", message)))

    companion object {
        const val PROTOCOL_VERSION = "0.4.0"
        private const val MAX_SESSIONS = 64
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
    private val events = mutableListOf<JSONObject>()
    private val subscribers = mutableSetOf<Channel<JSONObject>>()

    fun emit(event: JSONObject) {
        val enriched: JSONObject
        val overflowed = mutableListOf<Channel<JSONObject>>()
        synchronized(this) {
            seq += 1
            lastTouched = nowSeconds()
            enriched = JSONObject(event.toString())
                .put("seq", seq)
                .put("session_id", sessionId)
                .put("timestamp", lastTouched)
            events += enriched
            subscribers.forEach { channel ->
                if (channel.trySend(enriched).isFailure) overflowed += channel
            }
            subscribers.removeAll(overflowed.toSet())
        }
        overflowed.forEach { it.close(IllegalStateException("subscriber overflow; reconnect with after=$seq")) }
        val name = enriched.optString("event")
        if (name in PUSH_EVENTS) eventSink(enriched)
    }

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

    @Synchronized
    fun emitForTurn(generation: Long, nextStatus: String?, event: JSONObject): Boolean {
        if (turnGeneration != generation) return false
        if (nextStatus != null) status = nextStatus
        emit(event)
        return true
    }

    fun replay(after: Int): Flow<JSONObject> {
        val snapshot = synchronized(this) {
            events.filter { it.optInt("seq") > after }
        }
        return flow {
            snapshot.forEach { emit(it) }
        }
    }

    fun subscribe(after: Int): Flow<JSONObject> = flow {
        val channel = Channel<JSONObject>(capacity = LIVE_BUFFER)
        val snapshot = synchronized(this@MinisHarnessSession) {
            subscribers += channel
            events.filter { it.optInt("seq") > after }
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
        private const val LIVE_BUFFER = 64
        private val PUSH_EVENTS = setOf(
            "approval.request",
            "run.completed",
            "run.failed",
            "run.cancelled",
            "artifact.ready",
        )
    }
}
