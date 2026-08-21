package com.leoyuan.leophoneagent.relay

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject

class MinisHarnessRouterTest {
    private fun router(engine: MinisSessionEngine = FakeEngine()): MinisHarnessRouter =
        MinisHarnessRouter(appVersion = "1.0.0-alpha.6", engine = engine)

    @Test
    fun healthAndCapabilitiesAdvertiseAndroidMinis() {
        val health = router().handle("GET", "/health", null)
        assertEquals(200, health.status)
        assertEquals("ok", health.body.getString("status"))
        assertEquals("android", health.body.getString("platform"))
        assertEquals("minis", health.body.getString("server"))

        val caps = router().handle("GET", "/v1/capabilities", null)
        assertEquals("leoagent.capabilities", caps.body.getString("object"))
        val harnesses = caps.body.getJSONArray("harnesses")
        assertEquals(1, harnesses.length())
        assertEquals("minis", harnesses.getJSONObject(0).getString("key"))
        assertTrue(caps.body.getJSONObject("features").getBoolean("harness_sessions"))
    }

    @Test
    fun rejectsUnknownHarnessAndCreatesMinisSession() = runBlocking {
        val engine = FakeEngine()
        val r = router(engine)
        val bad = r.handle("POST", "/harness/sessions", JSONObject().put("harness", "codex").put("prompt", "x"))
        assertEquals(400, bad.status)
        assertTrue(bad.body.getJSONObject("error").getString("message").contains("minis"))

        val created = r.handle(
            "POST",
            "/harness/sessions",
            JSONObject().put("harness", "minis").put("prompt", "hello").put("thinking", "HIGH"),
        )
        assertEquals(202, created.status)
        val id = created.body.getString("session_id")
        assertTrue(id.startsWith("hs_"))
        assertEquals("minis", created.body.getString("harness"))
        waitForCompleted(r, id)
        assertEquals(listOf("hello"), engine.prompts)
        assertEquals(listOf("HIGH"), engine.thinking)

        val listed = r.handle("GET", "/harness/sessions", null)
        val row = listed.body.getJSONArray("sessions").getJSONObject(0)
        assertEquals(id, row.getString("session_id"))
        assertEquals("minis", row.getString("harness"))
    }

    @Test
    fun eventsAreResumableAndStopCancels() = runBlocking {
        val engine = FakeEngine(chunks = listOf(EngineChunk.Delta("hi"), EngineChunk.Completed("hi")))
        val r = router(engine)
        val created = r.handle("POST", "/harness/sessions", JSONObject().put("prompt", "go"))
        val id = created.body.getString("session_id")
        engine.awaitTurn()
        val replay = waitForCompleted(r, id)
        assertEquals("session.created", replay.first().getString("event"))
        assertTrue(replay.any { it.optString("event") == "user.message" })
        assertTrue(replay.any { it.optString("event") == "message.delta" && it.optString("delta") == "hi" })
        assertTrue(replay.any { it.optString("event") == "run.completed" })
        val lastSeq = replay.maxOf { it.getInt("seq") }
        assertTrue(r.eventsAfter(id, lastSeq).toList().isEmpty())

        val stopped = r.handle("POST", "/harness/sessions/$id/stop", JSONObject())
        assertEquals(200, stopped.status)
        assertEquals("cancelled", stopped.body.getString("status"))
        // engine.stop 现在是 suspend 且由 router 的 scope 异步执行（P0#9：
        // 不能再阻塞 OkHttp WS reader 线程），所以断言要等它落地。
        engine.awaitStopped(id)
    }

    @Test
    fun sendAndMissingSession() {
        val r = router()
        val missing = r.handle("POST", "/harness/sessions/nope/send", JSONObject().put("text", "x"))
        assertEquals(404, missing.status)
        val created = r.handle("POST", "/harness/sessions", JSONObject())
        val id = created.body.getString("session_id")
        val empty = r.handle("POST", "/harness/sessions/$id/send", JSONObject())
        assertEquals(400, empty.status)
        val sent = r.handle("POST", "/harness/sessions/$id/send", JSONObject().put("text", "follow"))
        assertEquals(200, sent.status)
        assertTrue(sent.body.getBoolean("ok"))
    }

    @Test
    fun sendWhileRunningStopsPreviousTurn() {
        val engine = FakeEngine()
        val r = router(engine)
        val created = r.handle("POST", "/harness/sessions", JSONObject().put("prompt", "first"))
        val id = created.body.getString("session_id")
        val sent = r.handle("POST", "/harness/sessions/$id/send", JSONObject().put("text", "steer"))
        assertEquals(200, sent.status)
        engine.awaitStopped(id)
    }

    @Test
    fun stopInvalidatesDelayedOldTurn() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val engine = object : MinisSessionEngine {
            override fun runTurn(sessionId: String, text: String, thinking: String?): Flow<EngineChunk> = flow {
                started.complete(Unit)
                emit(EngineChunk.Delta("old"))
                release.await()
                emit(EngineChunk.Completed("stale completion"))
            }
            override suspend fun stop(sessionId: String) = Unit
        }
        val r = router(engine)
        val id = r.handle("POST", "/harness/sessions", JSONObject().put("prompt", "go"))
            .body.getString("session_id")
        withTimeout(2_000) { started.await() }
        r.handle("POST", "/harness/sessions/$id/stop", JSONObject())
        release.complete(Unit)
        delay(100)

        val events = r.eventsAfter(id, 0).toList()
        val cancelledAt = events.indexOfFirst { it.optString("event") == "run.cancelled" }
        assertTrue(cancelledAt >= 0)
        assertFalse(events.drop(cancelledAt + 1).any { it.optString("event") == "run.completed" })
    }

    /**
     * P0#7 回归：steer 必须"先作废旧 turn 的 generation → 再 stop 引擎 →
     * 最后起新 turn"。原来是 `engine.stop()` 然后 `startTurn()`，
     * turnGeneration 直到 startTurn 里才自增，中间那段窗口里旧 turn 发出的
     * Completed 会通过校验，于是控制端收到一条带着旧输出的 run.completed。
     *
     * 顺序日志同时证明了新 turn 不会先于 stop 起跑。
     */
    @Test
    fun steerStopsPreviousTurnBeforeStartingTheNextOne() = runBlocking {
        val log = java.util.Collections.synchronizedList(mutableListOf<String>())
        val engine = object : MinisSessionEngine {
            override fun runTurn(sessionId: String, text: String, thinking: String?): Flow<EngineChunk> =
                flow {
                    log += "run:$text"
                    emit(EngineChunk.Completed(text))
                }

            override suspend fun stop(sessionId: String) {
                log += "stop"
            }
        }
        val r = router(engine)
        val id = r.handle("POST", "/harness/sessions", JSONObject().put("prompt", "first"))
            .body.getString("session_id")
        waitForCompleted(r, id)
        assertEquals(200, r.handle("POST", "/harness/sessions/$id/send", JSONObject().put("text", "steer")).status)

        var completions = emptyList<String>()
        var spins = 0
        while (spins < 200) {
            completions = r.eventsAfter(id, 0).toList()
                .filter { ev -> ev.optString("event") == "run.completed" }
                .map { ev -> ev.optString("output") }
            if (completions.size >= 2) break
            Thread.sleep(10)
            spins += 1
        }

        assertEquals(listOf("run:first", "stop", "run:steer"), synchronized(log) { log.toList() })
        // 终态事件里只能有两轮各自的输出，不能出现旧 turn 重复发出的终态。
        assertEquals(listOf("first", "steer"), completions)
    }

    /**
     * P0#9 回归：`handle()` 跑在 OkHttp WebSocket 的 reader 线程上，
     * 绝不能同步等待 engine.stop（原实现是 runBlocking → withContext(Main)）。
     * 这里让 stop 慢 2 秒，断言 stop/send 两条路由都立刻返回。
     */
    @Test
    fun stopAndSteerDoNotBlockTheCallingThread() = runBlocking {
        val engine = object : MinisSessionEngine {
            override fun runTurn(sessionId: String, text: String, thinking: String?): Flow<EngineChunk> =
                flow { emit(EngineChunk.Completed(text)) }

            override suspend fun stop(sessionId: String) {
                delay(2_000)
            }
        }
        val r = router(engine)
        val id = r.handle("POST", "/harness/sessions", JSONObject().put("prompt", "go"))
            .body.getString("session_id")
        val startedAt = System.nanoTime()
        assertEquals(200, r.handle("POST", "/harness/sessions/$id/send", JSONObject().put("text", "steer")).status)
        assertEquals(200, r.handle("POST", "/harness/sessions/$id/stop", JSONObject()).status)
        val elapsedMs = (System.nanoTime() - startedAt) / 1_000_000
        assertTrue("router blocked on engine.stop for ${elapsedMs}ms", elapsedMs < 1_000)
    }

    /**
     * P0#5 回归：事件表是有界环形缓冲，被丢弃区段的 after 必须显式回 410，
     * 而不是静默地少发一段（控制端会拼出残缺输出）。
     */
    @Test
    fun evictedEventsAreReportedInsteadOfSilentlySkipped() = runBlocking {
        val chunks = (1..3000).map { EngineChunk.Delta("d$it") } + EngineChunk.Completed("done")
        val r = router(FakeEngine(chunks))
        val id = r.handle("POST", "/harness/sessions", JSONObject().put("prompt", "flood"))
            .body.getString("session_id")
        waitForCompleted(r, id)

        val stale = r.handle("GET", "/harness/sessions/$id/events?after=0", null)
        assertEquals(410, stale.status)
        val minAfter = stale.body.getInt("min_after")
        assertTrue("nothing was evicted; ring buffer did not engage", minAfter > 0)

        // 按 410 给出的水位重新订阅就能正常开流（这条是 live stream，
        // 只断言状态，不 collect —— 它要等到订阅方主动断开才结束）。
        assertEquals(200, r.handle("GET", "/harness/sessions/$id/events?after=$minAfter", null).status)

        // 保留区段本身必须是连续的：环形缓冲不能在中间挖洞。
        val replayed = r.eventsAfter(id, minAfter).toList()
        assertTrue(replayed.isNotEmpty())
        assertEquals(minAfter + 1, replayed.first().getInt("seq"))
        replayed.zipWithNext().forEach { (a, b) ->
            assertEquals(a.getInt("seq") + 1, b.getInt("seq"))
        }
        assertTrue(replayed.any { it.optString("event") == "run.completed" })
    }

    @Test
    fun slowSubscriberFailsClosedInsteadOfSilentlySkippingSequences() = runBlocking {
        // Keep this above MinisHarnessSession.LIVE_BUFFER (currently 512),
        // otherwise the deliberately slow collector never overflows and the
        // test waits forever instead of exercising the fail-closed path.
        val chunks = (1..5_000).map { EngineChunk.Delta("$it") } + EngineChunk.Completed("done")
        val r = router(FakeEngine(chunks))
        val id = r.handle("POST", "/harness/sessions", JSONObject()).body.getString("session_id")
        val stream = r.handle("GET", "/harness/sessions/$id/events?after=0", null).stream!!
        val result = async {
            runCatching {
                // Slow enough to overflow while still draining the already
                // buffered items quickly enough to observe the close cause.
                stream.collect { delay(1) }
            }.exceptionOrNull()
        }
        delay(50)
        r.handle("POST", "/harness/sessions/$id/send", JSONObject().put("text", "flood"))

        assertNotNull(withTimeout(5_000) { result.await() })
    }
}

private class FakeEngine(
    private val chunks: List<EngineChunk> = listOf(
        EngineChunk.Delta("ok"),
        EngineChunk.Completed("ok"),
    ),
) : MinisSessionEngine {
    val prompts = mutableListOf<String>()
    val thinking = mutableListOf<String?>()
    val stopped = java.util.Collections.synchronizedList(mutableListOf<String>())
    @Volatile private var turns = 0

    override fun runTurn(sessionId: String, text: String, thinking: String?): Flow<EngineChunk> = flow {
        prompts += text
        this@FakeEngine.thinking += thinking
        turns += 1
        chunks.forEach { emit(it) }
    }

    override suspend fun stop(sessionId: String) {
        synchronized(stopped) { stopped += sessionId }
    }

    fun awaitTurn() {
        var spins = 0
        while (turns == 0 && spins < 200) {
            Thread.sleep(10)
            spins += 1
        }
        assertTrue("engine never started a turn", turns > 0)
    }

    /** stop 变成 suspend 之后由 router scope 异步执行，断言需要轮询等待。 */
    fun awaitStopped(sessionId: String) {
        var spins = 0
        while (spins < 200) {
            if (synchronized(stopped) { stopped.contains(sessionId) }) return
            Thread.sleep(10)
            spins += 1
        }
        assertTrue("engine.stop was never called for $sessionId", false)
    }
}

private fun waitForCompleted(router: MinisHarnessRouter, id: String): List<org.json.JSONObject> {
    repeat(80) {
        val replay = kotlinx.coroutines.runBlocking { router.eventsAfter(id, 0).toList() }
        if (replay.any { it.optString("event") == "run.completed" }) return replay
        Thread.sleep(25)
    }
    return kotlinx.coroutines.runBlocking { router.eventsAfter(id, 0).toList() }
}
