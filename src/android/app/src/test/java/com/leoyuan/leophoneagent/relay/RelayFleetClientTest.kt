package com.leoyuan.leophoneagent.relay

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class RelayFleetClientTest {
    private lateinit var server: MockWebServer
    private lateinit var client: RelayFleetClient

    @Before fun setUp() {
        server = MockWebServer().also { it.start() }
        // MockWebServer itself is cleartext; the test-only factory bypasses
        // only scheme validation while all request/auth behavior stays real.
        val config = RelayFleetConfig(server.url("/relay/api").toString().trimEnd('/'), "1234567890abcdef")
        client = RelayFleetClient.forTest(config, OkHttpClient())
    }

    @After fun tearDown() { server.shutdown() }

    @Test fun listsMachinesWithBearerToken() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"machines":[{"name":"cortex","online":true,"version":"1.2"}]}"""))
        val rows = client.machines()
        assertEquals("cortex", rows.single().name)
        assertTrue(rows.single().online)
        val request = server.takeRequest()
        assertEquals("/relay/api/machines", request.path)
        assertEquals("Bearer 1234567890abcdef", request.getHeader("Authorization"))
    }

    @Test fun startsStopsAndApprovesSpecificSession() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"session_id":"s-1"}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))

        assertEquals("s-1", client.startTask("cortex", "ship it", "codex", "/repo"))
        client.approve("cortex", "s-1", "ap-9", "once")
        client.stop("cortex", "s-1")

        val start = server.takeRequest()
        assertEquals("/relay/api/m/cortex/harness/sessions", start.path)
        assertTrue(start.body.readUtf8().contains("\"prompt\":\"ship it\""))
        val approval = server.takeRequest()
        assertTrue(approval.path!!.endsWith("/s-1/approval"))
        assertTrue(approval.body.readUtf8().contains("\"approval_id\":\"ap-9\""))
        assertTrue(server.takeRequest().path!!.endsWith("/s-1/stop"))
    }

    @Test fun parsesWrappedApprovalAndUsesObservedWatermark() = runBlocking {
        server.enqueue(MockResponse().setBody("""
            {"events":[{"machine":"cortex","received_at":42.5,"event":{
              "event":"approval.request","session_id":"s-2","approval_id":"ap-2",
              "command":"git push","choices":["once","deny"],"seq":7
            }}],"now":99.0}
        """.trimIndent()))
        val batch = client.relayEvents(40.0)
        assertEquals(42.5, batch.now, 0.0)
        assertEquals("cortex", batch.approvals.single().machine)
        assertEquals("ap-2", batch.approvals.single().approvalId)
        assertEquals(listOf("once", "deny"), batch.approvals.single().choices)
    }

    @Test fun unauthorizedNeverLeaksKeyInError() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"message":"bad"}}"""))
        val error = try {
            client.machines()
            throw AssertionError("Expected RelayException")
        } catch (expected: RelayException) {
            expected
        }
        assertEquals("中继密钥被拒绝", error.message)
        assertTrue(!error.message.orEmpty().contains("1234567890abcdef"))
    }

    @Test fun productionBaseRequiresHttps() {
        val rejected = runCatching {
            RelayFleetStore.normalizeBase("http://relay.example.com/relay/api")
        }.exceptionOrNull()
        assertTrue(rejected is IllegalArgumentException)
        assertTrue(runCatching {
            RelayFleetStore.normalizeBase("https://relay.example.com/relay/api?token=wrong-place")
        }.exceptionOrNull() is IllegalArgumentException)
        assertEquals(
            "https://relay.example.com/relay/api",
            RelayFleetStore.normalizeBase(" https://relay.example.com/relay/api/ "),
        )
    }
}
