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
        assertEquals(listOf(id), engine.stopped)
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
        assertEquals(listOf(id), engine.stopped)
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
            override fun stop(sessionId: String) = Unit
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

    @Test
    fun slowSubscriberFailsClosedInsteadOfSilentlySkippingSequences() = runBlocking {
        val chunks = (1..100).map { EngineChunk.Delta("$it") } + EngineChunk.Completed("done")
        val r = router(FakeEngine(chunks))
        val id = r.handle("POST", "/harness/sessions", JSONObject()).body.getString("session_id")
        val stream = r.handle("GET", "/harness/sessions/$id/events?after=0", null).stream!!
        val result = async {
            runCatching {
                stream.collect { delay(20) }
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
    val stopped = mutableListOf<String>()
    @Volatile private var turns = 0

    override fun runTurn(sessionId: String, text: String, thinking: String?): Flow<EngineChunk> = flow {
        prompts += text
        this@FakeEngine.thinking += thinking
        turns += 1
        chunks.forEach { emit(it) }
    }

    override fun stop(sessionId: String) {
        stopped += sessionId
    }

    fun awaitTurn() {
        var spins = 0
        while (turns == 0 && spins < 200) {
            Thread.sleep(10)
            spins += 1
        }
        assertTrue("engine never started a turn", turns > 0)
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
