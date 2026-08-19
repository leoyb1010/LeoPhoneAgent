package com.leoyuan.leophoneagent.relay

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class RelayOutboundClientTest {
    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer().also { it.start() }
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun registersForwardsHttpAndRelaysStreamData() {
        val registered = CountDownLatch(1)
        val gotResp = CountDownLatch(1)
        val streamClosed = CountDownLatch(1)
        val gotTerminalEvent = CountDownLatch(1)
        val register = arrayOfNulls<JSONObject>(1)
        val resp = arrayOfNulls<JSONObject>(1)
        val streamFrames = mutableListOf<JSONObject>()
        var agent: WebSocket? = null

        server.enqueue(
            MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    agent = webSocket
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val frame = JSONObject(text)
                    when (frame.optString("type")) {
                        "register" -> {
                            register[0] = frame
                            registered.countDown()
                            webSocket.send("""{"type":"registered"}""")
                        }
                        "resp" -> {
                            resp[0] = frame
                            gotResp.countDown()
                        }
                        "stream_data" -> streamFrames += frame
                        "stream_close" -> streamClosed.countDown()
                        "event" -> if (frame.optJSONObject("event")?.optString("event") == "run.completed") {
                            gotTerminalEvent.countDown()
                        }
                    }
                }
            }),
        )

        val engine = object : MinisSessionEngine {
            override fun runTurn(sessionId: String, text: String, thinking: String?): Flow<EngineChunk> = flow {
                emit(EngineChunk.Delta("hi"))
                emit(EngineChunk.Completed("hi"))
            }
            override fun stop(sessionId: String) = Unit
        }
        val router = MinisHarnessRouter("test", engine)
        val wsUrl = server.url("/relay/agent").toString().replace("http://", "ws://")
        val client = RelayOutboundClient(
            RelayOutboundConfig(wsUrl, "relay-key-0123456789abcdef", "LeoFold8", "test"),
            router,
            OkHttpClient(),
        )
        router.setEventSink(client::pushEvent)
        val run = Thread { runCatching { client.connectOnce() } }.also { it.start() }

        assertTrue(registered.await(5, TimeUnit.SECONDS))
        assertEquals("LeoFold8", register[0]!!.getString("name"))
        assertEquals("android", register[0]!!.getJSONObject("info").getString("platform"))

        agent!!.send("""{"type":"http","id":"r1","method":"GET","path":"/health"}""")
        assertTrue(gotResp.await(5, TimeUnit.SECONDS))
        assertEquals("r1", resp[0]!!.getString("id"))
        assertEquals(200, resp[0]!!.getInt("status"))
        assertEquals("minis", resp[0]!!.getJSONObject("body").getString("server"))

        val created = router.handle(
            "POST",
            "/harness/sessions",
            JSONObject().put("harness", "minis").put("prompt", "go"),
        )
        val sessionId = created.body.getString("session_id")
        assertTrue(gotTerminalEvent.await(5, TimeUnit.SECONDS))
        agent.send("""{"type":"stream_open","id":"s1","path":"/harness/sessions/$sessionId/events?after=0"}""")
        repeat(40) {
            if (streamFrames.any { it.optString("data").contains("session.created") }) return@repeat
            Thread.sleep(50)
        }
        assertTrue(streamFrames.any { it.optString("data").contains("session.created") })
        agent.send("""{"type":"stream_cancel","id":"s1"}""")
        assertTrue(streamClosed.await(5, TimeUnit.SECONDS))

        agent.close(1000, "done")
        run.join(2000)
        client.stop()
    }

    @Test
    fun stopDuringHandshakeNeverRegistersWithStaleKey() {
        val registered = CountDownLatch(1)
        server.enqueue(
            MockResponse()
                .setHeadersDelay(500, TimeUnit.MILLISECONDS)
                .withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        if (JSONObject(text).optString("type") == "register") registered.countDown()
                    }
                }),
        )
        val router = MinisHarnessRouter("test", object : MinisSessionEngine {
            override fun runTurn(sessionId: String, text: String, thinking: String?): Flow<EngineChunk> = flow { }
            override fun stop(sessionId: String) = Unit
        })
        val client = RelayOutboundClient(
            RelayOutboundConfig(
                server.url("/relay/agent").toString().replace("http://", "ws://"),
                "old-relay-key-0123456789abcdef",
                "LeoFold8",
                "test",
            ),
            router,
            OkHttpClient(),
        )
        val run = Thread { runCatching { client.connectOnce() } }.also { it.start() }
        Thread.sleep(50)
        client.stop()

        assertFalse(registered.await(1, TimeUnit.SECONDS))
        run.join(2_000)
        assertFalse("stopped handshake must unblock connectOnce", run.isAlive)
    }
}
