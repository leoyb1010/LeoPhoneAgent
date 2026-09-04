package com.leoyuan.leophoneagent.provider.xai

import com.leoyuan.leophoneagent.provider.openai.OpenAIModelsApi
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class XAIDynamicCatalogTest {
    @Test fun `xAI compatible endpoint keeps newly released model ids`() = runBlocking {
        val server = MockWebServer()
        server.start()
        try {
            server.enqueue(MockResponse().setResponseCode(200).setBody(
                """{"data":[{"id":"grok-4.6"},{"id":"grok-composer-next"}]}""",
            ))
            val models = OpenAIModelsApi.fetchModels("oauth-token", server.url("/v1").toString())
            assertEquals(listOf("grok-4.6", "grok-composer-next"), models.map { it.id })
            val request = server.takeRequest()
            assertEquals("/v1/models", request.path)
            assertEquals("Bearer oauth-token", request.getHeader("Authorization"))
            assertTrue(models.all { it.provider == "Custom" })
        } finally {
            server.shutdown()
        }
    }
}
