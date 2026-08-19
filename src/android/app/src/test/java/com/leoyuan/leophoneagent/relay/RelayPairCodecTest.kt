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
}
