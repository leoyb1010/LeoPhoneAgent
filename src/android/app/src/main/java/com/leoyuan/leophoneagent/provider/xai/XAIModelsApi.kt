package com.leoyuan.leophoneagent.provider.xai

import com.leoyuan.leophoneagent.data.model.LLMModel
import com.leoyuan.leophoneagent.logging.AppLogger
import com.leoyuan.leophoneagent.provider.ModelsDevApi

/**
 * Static catalog of xAI (Grok) models exposed to OAuth users.
 * Mirrors OpenMinis iOS/Android: OAuth model selection must not depend on a
 * CLI-only catalog endpoint that can return a smaller subscription subset.
 */
object XAIModelsApi {
    private const val TAG = "XAIModelsApi"
    fun fetchModelsOAuth(): List<LLMModel> {
        val models = ModelsDevApi.enrichModels(LLMModel.allXAI)
        AppLogger.info(TAG, "xAI OAuth built-in model list (${models.size} models)")
        return models
    }
}
