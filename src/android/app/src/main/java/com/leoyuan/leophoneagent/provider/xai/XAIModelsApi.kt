package com.leoyuan.leophoneagent.provider.xai

import com.leoyuan.leophoneagent.data.model.LLMModel
import com.leoyuan.leophoneagent.logging.AppLogger
import com.leoyuan.leophoneagent.provider.ModelsDevApi

/**
 * Built-in xAI (Grok) seed and offline fallback.
 *
 * ProviderRepository refreshes from xAI's authenticated /v1/models endpoint
 * first so new models appear without waiting for an app release. This list
 * keeps first-run and offline model selection usable when the live endpoint is
 * unavailable or returns no models for the current subscription.
 */
object XAIModelsApi {
    private const val TAG = "XAIModelsApi"
    fun fetchModelsOAuth(): List<LLMModel> {
        val models = ModelsDevApi.enrichModels(LLMModel.allXAI)
        AppLogger.info(TAG, "xAI OAuth built-in model list (${models.size} models)")
        return models
    }
}
