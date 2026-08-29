package com.leoyuan.leophoneagent.provider.xai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class XAIModelsApiTest {
    @Test
    fun oauthCatalogMatchesOpenMinisAndKeepsRequiredModels() {
        val models = XAIModelsApi.fetchModelsOAuth()

        assertTrue(models.size >= 13)
        assertTrue(models.any { it.id == "grok-4.6" })
        assertTrue(models.any { it.id == "grok-composer-2.5-fast" })
        assertEquals(models.size, models.distinctBy { it.id }.size)
    }
}
