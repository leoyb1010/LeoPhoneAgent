package com.leoyuan.leophoneagent.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayOutboundCodecTest {
    @Test
    fun agentWsUrlRewritesRelayApiToAgent() {
        assertEquals(
            "wss://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/agent",
            RelayOutboundCodec.agentWsUrl(
                "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api",
            ),
        )
        assertEquals(
            "wss://host.example/leoagent-relay/relay/agent",
            RelayOutboundCodec.agentWsUrl("https://host.example/leoagent-relay/relay"),
        )
        assertEquals(
            "ws://127.0.0.1:9/relay/agent",
            RelayOutboundCodec.agentWsUrl("http://127.0.0.1:9/relay/api/"),
        )
    }

    @Test
    fun registerFrameUsesAndroidPlatformAndNeverPutsKeyInInfo() {
        val frame = RelayOutboundCodec.registerFrame(
            name = "LeoFold8",
            key = "relay-key-0123456789abcdef",
            version = "1.0.0-alpha.6",
        )
        assertEquals("register", frame.getString("type"))
        assertEquals("LeoFold8", frame.getString("name"))
        assertEquals("relay-key-0123456789abcdef", frame.getString("key"))
        val info = frame.getJSONObject("info")
        assertEquals("android", info.getString("platform"))
        assertEquals("minis", info.getString("server"))
        assertEquals("1.0.0-alpha.6", info.getString("version"))
        assertTrue(!info.toString().contains("relay-key"))
    }

    @Test
    fun parseIgnoresNonJsonAndBuildsRespAndStreamFrames() {
        assertNull(RelayOutboundCodec.parse("not-json"))
        val http = RelayOutboundCodec.parse("""{"type":"http","id":"r1","method":"GET","path":"/health"}""")
        assertEquals("http", http!!.getString("type"))
        val resp = RelayOutboundCodec.resp("r1", 200, org.json.JSONObject().put("ok", true))
        assertEquals("resp", resp.getString("type"))
        assertEquals(200, resp.getInt("status"))
        val data = RelayOutboundCodec.streamData("s1", """{"seq":1}""")
        assertEquals("stream_data", data.getString("type"))
        assertEquals("""{"seq":1}""", data.getString("data"))
        assertEquals("s1", RelayOutboundCodec.streamClose("s1").getString("id"))
    }

    @Test
    fun sseLineExtractsDataAndDropsKeepAlive() {
        assertEquals("""{"seq":1}""", RelayOutboundCodec.ssePayload("data: {\"seq\":1}"))
        assertNull(RelayOutboundCodec.ssePayload(": keep-alive"))
        assertNull(RelayOutboundCodec.ssePayload(""))
        assertEquals("{}", RelayOutboundCodec.ssePayload("data: {}"))
    }
}
