package com.leoyuan.leophoneagent.provider.xai

import android.content.Context
import com.leoyuan.leophoneagent.BuildConfig
import com.leoyuan.leophoneagent.data.model.LLMModel
import com.leoyuan.leophoneagent.logging.AppLogger
import com.leoyuan.leophoneagent.provider.ModelsDevApi
import com.leoyuan.leophoneagent.provider.ProviderModelsCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject

/**
 * Grok OAuth catalog from xAI's first-party CLI proxy. API-key accounts use
 * api.x.ai via OpenAIModelsApi; OAuth tokens must never be sent there or to a
 * user-supplied base URL. The built-in list is only an offline fallback.
 */
object XAIModelsApi {
    private const val TAG = "XAIModelsApi"
    const val OAUTH_API_BASE = "https://cli-chat-proxy.grok.com/v1"
    private const val MODELS_URL = "$OAUTH_API_BASE/models"
    private val client = OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()
    private val cache = ProviderModelsCache("xai-oauth")

    fun fallbackModels(): List<LLMModel> = ModelsDevApi.enrichModels(LLMModel.allXAI)

    suspend fun fetchModelsOAuth(
        accessToken: String,
        userId: String?,
        email: String?,
        context: Context? = null,
        forceRefresh: Boolean = false,
    ): List<LLMModel> = withContext(Dispatchers.IO) {
        val cacheKey = userId ?: email ?: "oauth"
        if (context != null && !forceRefresh) {
            cache.load(context, cacheKey)?.let { return@withContext it }
        }
        val request = Request.Builder()
            .url(MODELS_URL)
            .header("Authorization", "Bearer $accessToken")
            .header("X-XAI-Token-Auth", "xai-grok-cli")
            .header("x-grok-client-version", BuildConfig.VERSION_NAME)
            .header("x-grok-client-mode", "app")
            .apply {
                userId?.takeIf { it.isNotBlank() }?.let { header("x-userid", it) }
                email?.takeIf { it.isNotBlank() }?.let { header("x-user-email", it) }
            }
            .build()
        val parsed = runCatching {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    AppLogger.warning(TAG, "xAI OAuth catalog failed: HTTP ${response.code}")
                    return@use emptyList()
                }
                parseModels(response.body?.string().orEmpty())
            }
        }.getOrElse {
            AppLogger.warning(TAG, "xAI OAuth catalog unavailable: ${it.javaClass.simpleName}")
            emptyList()
        }
        if (parsed.isEmpty()) return@withContext fallbackModels()
        val enriched = ModelsDevApi.enrichModels(parsed)
        if (context != null) cache.save(context, cacheKey, enriched)
        AppLogger.info(TAG, "xAI OAuth catalog loaded (${enriched.size} models)")
        enriched
    }

    internal fun parseModels(raw: String): List<LLMModel> {
        if (raw.isBlank()) return emptyList()
        val root = JSONObject(raw)
        val data = root.optJSONArray("data") ?: root.optJSONArray("models") ?: return emptyList()
        return buildList {
            for (index in 0 until data.length()) {
                val item = data.optJSONObject(index) ?: continue
                if (item.optBoolean("hidden", false) || item.has("supportedInApi") && !item.optBoolean("supportedInApi", true)) continue
                val id = sequenceOf("id", "model", "modelId").map { item.optString(it) }.firstOrNull { it.isNotBlank() } ?: continue
                val family = item.optString("modelFamily", id)
                val lower = "$id $family".lowercase()
                val reasoning = item.optBoolean("supportsReasoning", false) ||
                    item.optJSONArray("reasoningEfforts")?.length()?.let { it > 0 } == true ||
                    lower.contains("reasoning") || lower.startsWith("grok-4")
                val input = item.optJSONArray("inputModalities").toStrings().ifEmpty {
                    if (item.optBoolean("supportsImages", false)) listOf("text", "image") else listOf("text")
                }
                val output = item.optJSONArray("outputModalities").toStrings().ifEmpty { listOf("text") }
                add(LLMModel(
                    id = id,
                    displayName = item.optString("name").ifBlank { LLMModel.modelDisplayName(id) },
                    provider = "xAI",
                    contextWindow = item.optPositiveInt("contextWindow", "contextLength", "maxContextTokens"),
                    maxOutputTokens = item.optPositiveInt("maxOutputTokens", "maxTokens"),
                    supportsReasoning = reasoning,
                    inputModalities = input,
                    outputModalities = output,
                ))
            }
        }.distinctBy { it.id }
    }

    private fun JSONArray?.toStrings(): List<String> = if (this == null) emptyList() else buildList {
        for (index in 0 until length()) optString(index).takeIf { it.isNotBlank() }?.let(::add)
    }

    private fun JSONObject.optPositiveInt(vararg keys: String): Int? = keys.asSequence()
        .map { optLong(it, 0L) }
        .firstOrNull { it in 1..Int.MAX_VALUE }
        ?.toInt()
}
