package com.leoyuan.leophoneagent.sandbox

import android.content.Context
import android.os.SystemClock
import com.leoyuan.leophoneagent.data.model.ProviderCredential
import com.leoyuan.leophoneagent.data.model.ProviderType
import com.leoyuan.leophoneagent.data.repository.ProviderRepository
import java.util.concurrent.atomic.AtomicReference

data class CliToolPreference(
    val model: String = "",
    val useLeoApiKey: Boolean = false,
)

class CliToolPreferences(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("cli_tool_preferences", Context.MODE_PRIVATE)

    fun get(id: CliToolId): CliToolPreference = CliToolPreference(
        model = prefs.getString("model_${id.name}", "").orEmpty(),
        useLeoApiKey = prefs.getBoolean("leo_key_${id.name}", false),
    )

    fun save(id: CliToolId, preference: CliToolPreference) {
        prefs.edit()
            .putString("model_${id.name}", preference.model.trim().take(200))
            .putBoolean("leo_key_${id.name}", preference.useLeoApiKey)
            .apply()
    }
}

enum class CliLaunchError {
    UNSUPPORTED,
    NO_CURRENT_MODEL,
    PROVIDER_MISMATCH,
    OAUTH_NOT_EXPORTABLE,
    CUSTOM_ENDPOINT_UNSUPPORTED,
    NO_API_KEY,
}

data class CliLaunchRequest(
    val command: String,
    val environment: Map<String, String> = emptyMap(),
)

sealed class CliLaunchResolution {
    data class Ready(val request: CliLaunchRequest) : CliLaunchResolution()
    data class Failed(val error: CliLaunchError) : CliLaunchResolution()
}

object CliToolLaunchResolver {
    fun resolve(
        spec: CliToolSpec,
        preference: CliToolPreference,
        providers: ProviderRepository,
    ): CliLaunchResolution {
        if (!preference.useLeoApiKey) {
            return CliLaunchResolution.Ready(CliLaunchRequest(spec.launchCommand(preference.model)))
        }

        // [T-cli-key-current-model] Same tier chain the chat composer uses:
        // last-used entry first, else the newest provider's newest text model.
        // Requiring a *used* entry meant a freshly configured provider (key
        // saved, model visible in the chat header, but no message sent yet)
        // still failed with NO_CURRENT_MODEL — the exact "开了开关也不能用"
        // report. The chat header and this resolver must agree on what the
        // current model is.
        val entry = providers.lastUsedVisibleEntry()
            ?: providers.newestProviderNewestTextEntry()
            ?: return CliLaunchResolution.Failed(CliLaunchError.NO_CURRENT_MODEL)
        val instance = providers.config.value.instances.firstOrNull { it.id == entry.providerInstanceId }
            ?: return CliLaunchResolution.Failed(CliLaunchError.NO_CURRENT_MODEL)
        return resolveCredential(
            spec,
            preference,
            LeoCliCredential(
                providerType = instance.providerType,
                credentialType = instance.credentialType,
                hasCustomEndpoint = instance.effectiveBaseURL != null || instance.azureMode,
                apiKey = providers.loadApiKey(instance.id),
                modelId = entry.model.id,
            ),
        )
    }

    internal fun resolveCredential(
        spec: CliToolSpec,
        preference: CliToolPreference,
        credential: LeoCliCredential,
    ): CliLaunchResolution {
        val expected = when (spec.id) {
            CliToolId.CLAUDE -> ProviderType.anthropic to "ANTHROPIC_API_KEY"
            CliToolId.CODEX -> ProviderType.openAI to "OPENAI_API_KEY"
            CliToolId.GROK -> ProviderType.xAI to "XAI_API_KEY"
            CliToolId.CURSOR -> return CliLaunchResolution.Failed(CliLaunchError.UNSUPPORTED)
        }
        if (credential.providerType != expected.first) {
            return CliLaunchResolution.Failed(CliLaunchError.PROVIDER_MISMATCH)
        }
        if (credential.credentialType != ProviderCredential.apiKey) {
            return CliLaunchResolution.Failed(CliLaunchError.OAUTH_NOT_EXPORTABLE)
        }
        if (credential.hasCustomEndpoint) {
            return CliLaunchResolution.Failed(CliLaunchError.CUSTOM_ENDPOINT_UNSUPPORTED)
        }
        val key = credential.apiKey?.trim().orEmpty()
        if (key.isEmpty()) return CliLaunchResolution.Failed(CliLaunchError.NO_API_KEY)

        val model = preference.model.ifBlank { credential.modelId }
        return CliLaunchResolution.Ready(
            CliLaunchRequest(
                command = spec.launchCommand(model),
                environment = mapOf(expected.second to key),
            ),
        )
    }
}

internal data class LeoCliCredential(
    val providerType: ProviderType,
    val credentialType: ProviderCredential,
    val hasCustomEndpoint: Boolean,
    val apiKey: String?,
    val modelId: String,
)

/** One-shot in-memory handoff; secrets never enter navigation routes, shell history, or disk. */
object CliLaunchEnvironment {
    private data class Pending(val values: Map<String, String>, val createdAtMs: Long)
    private val pending = AtomicReference<Pending?>(null)

    fun prepare(values: Map<String, String>) {
        pending.set(Pending(values.toMap(), SystemClock.elapsedRealtime()))
    }

    fun consume(): Map<String, String> {
        val value = pending.getAndSet(null) ?: return emptyMap()
        return if (SystemClock.elapsedRealtime() - value.createdAtMs <= MAX_AGE_MS) value.values else emptyMap()
    }

    internal const val MAX_AGE_MS = 10_000L
}
