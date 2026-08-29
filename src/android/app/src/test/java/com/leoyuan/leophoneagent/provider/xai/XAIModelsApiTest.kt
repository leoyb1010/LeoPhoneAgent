package com.leoyuan.leophoneagent.provider.xai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class XAIModelsApiTest {
    @Test
    fun parsesCurrentAndEntitledOAuthModelsWithoutInventingHiddenEntries() {
        val models = XAIModelsApi.parseModels(
            """{
              "models": [
                {"modelId":"grok-4.6","name":"Grok 4.6","contextWindow":500000,"reasoningEfforts":["low","high"],"supportsImages":true},
                {"id":"grok-composer-2.5-fast","modelFamily":"composer"},
                {"id":"internal-shadow","hidden":true},
                {"id":"not-for-api","supportedInApi":false}
              ]
            }""".trimIndent(),
        )

        assertEquals(listOf("grok-4.6", "grok-composer-2.5-fast"), models.map { it.id })
        assertEquals(500_000, models.first().contextWindow)
        assertTrue(models.first().supportsReasoning == true)
        assertEquals(listOf("text", "image"), models.first().inputModalities)
        assertFalse(models.any { it.id == "internal-shadow" || it.id == "not-for-api" })
    }

    @Test
    fun fallbackContainsOfficialGrok46() {
        assertTrue(XAIModelsApi.fallbackModels().any { it.id == "grok-4.6" })
    }
}
