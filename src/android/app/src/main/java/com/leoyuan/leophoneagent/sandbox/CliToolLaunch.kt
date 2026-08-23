package com.leoyuan.leophoneagent.sandbox

import android.content.Context
import android.os.SystemClock
import com.leoyuan.leophoneagent.data.model.ProviderCredential
import com.leoyuan.leophoneagent.data.model.ProviderType
import com.leoyuan.leophoneagent.data.repository.ProviderRepository
import java.net.URI
import java.util.concurrent.atomic.AtomicReference

data class CliToolPreference(
    val model: String = "",
    val useLeoApiKey: Boolean = false,
    val providerEntryId: String? = null,
)

class CliToolPreferences(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("cli_tool_preferences", Context.MODE_PRIVATE)

    fun get(id: CliToolId): CliToolPreference = CliToolPreference(
        model = prefs.getString("model_${id.name}", "").orEmpty(),
        useLeoApiKey = prefs.getBoolean("leo_key_${id.name}", false),
        providerEntryId = prefs.getString("leo_entry_${id.name}", null),
    )

    fun save(id: CliToolId, preference: CliToolPreference) {
        prefs.edit()
            .putString("model_${id.name}", preference.model.trim().take(200))
            .putBoolean("leo_key_${id.name}", preference.useLeoApiKey)
            .putString("leo_entry_${id.name}", preference.providerEntryId)
            .apply()
    }
}

enum class CliLaunchError {
    UNSUPPORTED,
    NO_CURRENT_MODEL,
    PROVIDER_MISMATCH,
    OAUTH_NOT_EXPORTABLE,
    CUSTOM_ENDPOINT_UNSUPPORTED,
    INCOMPATIBLE_PROTOCOL,
    UNSAFE_ENDPOINT,
    CONFIG_WRITE_FAILED,
    NO_API_KEY,
}

data class CliLaunchRequest(
    val command: String,
    val environment: Map<String, String> = emptyMap(),
    val managedConfig: CliManagedConfig? = null,
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
        val compatible = compatibleEntries(spec.id, providers)
        val entry = preference.providerEntryId
            ?.let { id -> compatible.firstOrNull { it.id == id } }
            ?: providers.lastUsedVisibleEntry()?.takeIf { last -> compatible.any { it.id == last.id } }
            ?: compatible.firstOrNull()
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
                baseUrl = instance.effectiveBaseURL,
                useResponsesAPI = instance.useResponsesAPI,
                azureMode = instance.azureMode,
                apiKey = providers.loadApiKey(instance.id),
                modelId = entry.model.id,
                providerLabel = instance.label.ifBlank { instance.providerType.displayName },
            ),
        )
    }

    internal fun resolveCredential(
        spec: CliToolSpec,
        preference: CliToolPreference,
        credential: LeoCliCredential,
    ): CliLaunchResolution {
        if (credential.credentialType != ProviderCredential.apiKey) {
            return CliLaunchResolution.Failed(CliLaunchError.OAUTH_NOT_EXPORTABLE)
        }
        val key = credential.apiKey?.trim().orEmpty()
        if (key.isEmpty()) return CliLaunchResolution.Failed(CliLaunchError.NO_API_KEY)

        val model = preference.model.ifBlank { credential.modelId }
        if (model.length > 200 || model.any(Char::isISOControl)) {
            return CliLaunchResolution.Failed(CliLaunchError.INCOMPATIBLE_PROTOCOL)
        }
        return when (spec.id) {
            CliToolId.CLAUDE -> resolveClaude(spec, model, key, credential)
            CliToolId.CODEX -> resolveCodex(spec, model, key, credential)
            CliToolId.GROK -> resolveGrok(spec, model, key, credential)
            CliToolId.CURSOR -> CliLaunchResolution.Failed(CliLaunchError.UNSUPPORTED)
        }
    }

    fun compatibleEntries(id: CliToolId, providers: ProviderRepository) =
        providers.allVisibleEntries().filter { entry ->
            val instance = providers.instance(entry.providerInstanceId) ?: return@filter false
            instance.isEnabled && instance.credentialType == ProviderCredential.apiKey && when (id) {
                CliToolId.CLAUDE -> instance.providerType == ProviderType.anthropic && !instance.azureMode
                CliToolId.CODEX -> codexCompatible(instance.providerType, instance.effectiveBaseURL, instance.useResponsesAPI, instance.azureMode)
                CliToolId.GROK -> instance.providerType != ProviderType.gemini && !instance.azureMode
                CliToolId.CURSOR -> false
            }
        }

    private fun resolveClaude(
        spec: CliToolSpec,
        model: String,
        key: String,
        credential: LeoCliCredential,
    ): CliLaunchResolution {
        if (credential.providerType != ProviderType.anthropic || credential.azureMode) {
            return CliLaunchResolution.Failed(CliLaunchError.PROVIDER_MISMATCH)
        }
        val rawBase = credential.baseUrl ?: "https://api.anthropic.com/v1"
        if (!safeBaseUrl(rawBase)) return CliLaunchResolution.Failed(CliLaunchError.UNSAFE_ENDPOINT)
        val base = rawBase.trimEnd('/').let { if (it.endsWith("/v1")) it.dropLast(3) else it }
        val custom = !base.equals("https://api.anthropic.com", ignoreCase = true)
        val env = mutableMapOf(
            "ANTHROPIC_MODEL" to model,
            (if (custom) "ANTHROPIC_AUTH_TOKEN" else "ANTHROPIC_API_KEY") to key,
        )
        if (custom) env["ANTHROPIC_BASE_URL"] = base
        // Keep the Leo-model profile separate from Claude's official-account
        // state. The seed marks only the CLI's display onboarding complete;
        // project trust prompts remain intact, and no credential is persisted.
        val profileDir = "/root/.leophone-cli/claude"
        val guestPath = "$profileDir/.claude.json"
        val config = CliManagedConfig(
            guestPath = guestPath,
            content = "{\"hasCompletedOnboarding\":true,\"theme\":\"dark\"}\n",
            preserveExisting = true,
        )
        env["CLAUDE_CONFIG_DIR"] = profileDir
        return ready(spec, model, env, config)
    }

    private fun resolveCodex(
        spec: CliToolSpec,
        model: String,
        key: String,
        credential: LeoCliCredential,
    ): CliLaunchResolution {
        if (!codexCompatible(credential.providerType, credential.baseUrl, credential.useResponsesAPI, credential.azureMode)) {
            return CliLaunchResolution.Failed(
                if (credential.azureMode || credential.providerType == ProviderType.gemini) CliLaunchError.PROVIDER_MISMATCH
                else CliLaunchError.INCOMPATIBLE_PROTOCOL,
            )
        }
        val base = credential.baseUrl ?: defaultBase(credential.providerType)
        if (!safeBaseUrl(base)) return CliLaunchResolution.Failed(CliLaunchError.UNSAFE_ENDPOINT)
        val guestPath = "/root/.leophone-cli/codex/leophone.config.toml"
        val content = """
            model = ${toml(model)}
            model_provider = "leophone"

            [model_providers.leophone]
            name = ${toml("LeoPhoneAgent · ${credential.providerLabel}")}
            base_url = ${toml(base.trimEnd('/'))}
            wire_api = "responses"
            env_key = "LEOPHONE_CLI_API_KEY"
        """.trimIndent() + "\n"
        val config = CliManagedConfig(guestPath, content, listOf("--profile", "leophone"))
        return ready(
            spec,
            model,
            mapOf(
                "LEOPHONE_CLI_API_KEY" to key,
                "CODEX_HOME" to "/root/.leophone-cli/codex",
            ),
            config,
        )
    }

    private fun resolveGrok(
        spec: CliToolSpec,
        model: String,
        key: String,
        credential: LeoCliCredential,
    ): CliLaunchResolution {
        if (credential.providerType == ProviderType.gemini || credential.azureMode) {
            return CliLaunchResolution.Failed(CliLaunchError.PROVIDER_MISMATCH)
        }
        val base = credential.baseUrl ?: defaultBase(credential.providerType)
        if (!safeBaseUrl(base)) return CliLaunchResolution.Failed(CliLaunchError.UNSAFE_ENDPOINT)
        val backend = when (credential.providerType) {
            ProviderType.anthropic -> "messages"
            else -> if (credential.useResponsesAPI) "responses" else "chat_completions"
        }
        val guestPath = "/root/.leophone-cli/grok/config.toml"
        val content = """
            [model.${toml(model)}]
            model = ${toml(model)}
            base_url = ${toml(base.trimEnd('/'))}
            name = ${toml("LeoPhoneAgent · ${credential.providerLabel}")}
            env_key = "LEOPHONE_CLI_API_KEY"
            api_backend = ${toml(backend)}
        """.trimIndent() + "\n"
        val config = CliManagedConfig(guestPath, content)
        return ready(
            spec,
            model,
            mapOf(
                "LEOPHONE_CLI_API_KEY" to key,
                "GROK_HOME" to "/root/.leophone-cli/grok",
                "GROK_DEFAULT_MODEL" to model,
            ),
            config,
        )
    }

    private fun ready(
        spec: CliToolSpec,
        model: String,
        environment: Map<String, String>,
        config: CliManagedConfig,
    ) = CliLaunchResolution.Ready(
        CliLaunchRequest(
            command = spec.launchCommand(model, extraArguments = config.arguments),
            environment = environment,
            managedConfig = config,
        ),
    )

    private fun codexCompatible(
        type: ProviderType,
        baseUrl: String?,
        responses: Boolean,
        azure: Boolean,
    ): Boolean {
        if (azure || type == ProviderType.gemini || type == ProviderType.anthropic) return false
        return type == ProviderType.openAI && baseUrl == null || responses
    }

    private fun defaultBase(type: ProviderType): String = when (type) {
        ProviderType.anthropic -> "https://api.anthropic.com/v1"
        ProviderType.openAI -> "https://api.openai.com/v1"
        ProviderType.openRouter -> "https://openrouter.ai/api/v1"
        ProviderType.xAI -> "https://api.x.ai/v1"
        ProviderType.kimiCode -> "https://api.kimi.com/coding/v1"
        ProviderType.gemini -> error("Gemini is not CLI-compatible")
    }

    private fun safeBaseUrl(value: String): Boolean = runCatching {
        if (value.length > 2048 || value.any(Char::isISOControl)) return false
        val uri = URI(value)
        val host = uri.host?.lowercase() ?: return false
        val loopback = host in setOf("127.0.0.1", "localhost", "::1")
        (uri.scheme == "https" || (uri.scheme == "http" && loopback)) &&
            uri.userInfo == null && uri.fragment == null
    }.getOrDefault(false)

    private fun toml(value: String): String = "\"${value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n")}\""
}

internal data class LeoCliCredential(
    val providerType: ProviderType,
    val credentialType: ProviderCredential,
    val hasCustomEndpoint: Boolean,
    val baseUrl: String? = null,
    val useResponsesAPI: Boolean = false,
    val azureMode: Boolean = false,
    val apiKey: String?,
    val modelId: String,
    val providerLabel: String = providerType.displayName,
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
