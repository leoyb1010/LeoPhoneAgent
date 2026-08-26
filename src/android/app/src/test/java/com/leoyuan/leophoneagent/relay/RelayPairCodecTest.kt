package com.leoyuan.leophoneagent.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class RelayPairCodecTest {
    @Test
    fun roundTripKeepsRootAndName() {
        val encoded = RelayPairCodec.encode(
            "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api/",
            "LeoFold8",
        )
        val parsed = RelayPairCodec.decode(encoded)
        assertEquals(
            "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api",
            parsed?.apiRoot,
        )
        assertEquals("LeoFold8", parsed?.machine)
    }

    @Test
    fun rejectsHttpAndMissingFields() {
        assertNull(RelayPairCodec.decode("leoagent-body:v1|{\"apiRoot\":\"http://evil\",\"machine\":\"x\"}"))
        assertNull(RelayPairCodec.decode("leoagent-body:v1|{\"apiRoot\":\"https://ok\",\"machine\":\"\"}"))
        assertNull(RelayPairCodec.decode("not-a-pair"))
        assertNull(RelayPairCodec.decode("leoagent-body:v1|{\"apiRoot\":\"https://ok\",\"machine\":\"a/b\"}"))
    }

    @Test
    fun keyNeverEncoded() {
        val encoded = RelayPairCodec.encode("https://example.ts.net/relay/api", "phone")
        assert(!encoded.contains("key"))
        assert(!encoded.contains("secret"))
    }

    @Test
    fun v2RoundTripKeepsJoinTokenAndNeverEncodesKey() {
        val encoded = RelayPairCodec.encode(
            "https://example.ts.net/relay/api",
            "phone",
            "join-short",
            1_800_000_000L,
        )
        assert(encoded.startsWith(RelayPairCodec.PREFIX_V2))
        assert(!encoded.contains("key"))
        val parsed = RelayPairCodec.decode(encoded)
        assertEquals("https://example.ts.net/relay/api", parsed?.apiRoot)
        assertEquals("phone", parsed?.machine)
        assertEquals("join-short", parsed?.join)
        assertEquals(1_800_000_000L, parsed?.exp)
        assertEquals("LeoFold8", RelayPairCodec.decode(
            RelayPairCodec.encode("https://ok.example/relay/api", "LeoFold8"),
        )?.machine)
    }
}
