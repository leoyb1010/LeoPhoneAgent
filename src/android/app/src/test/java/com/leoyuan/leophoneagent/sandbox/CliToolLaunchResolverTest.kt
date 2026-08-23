package com.leoyuan.leophoneagent.sandbox

import com.leoyuan.leophoneagent.data.model.ProviderCredential
import com.leoyuan.leophoneagent.data.model.ProviderType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CliToolLaunchResolverTest {
    @Test
    fun matchingApiKeyIsPassedByEnvironmentNotCommand() {
        val result = CliToolLaunchResolver.resolveCredential(
            CliToolCatalog.get(CliToolId.CODEX),
            CliToolPreference(useLeoApiKey = true),
            LeoCliCredential(
                ProviderType.openAI,
                ProviderCredential.apiKey,
                hasCustomEndpoint = false,
                apiKey = "secret-canary",
                modelId = "gpt-5.6",
            ),
        ) as CliLaunchResolution.Ready

        assertEquals("secret-canary", result.request.environment["LEOPHONE_CLI_API_KEY"])
        assertTrue(result.request.command.contains("gpt-5.6"))
        assertFalse(result.request.command.contains("secret-canary"))
    }

    @Test
    fun oauthAndWrongProviderFailClosed() {
        val spec = CliToolCatalog.get(CliToolId.CLAUDE)
        val pref = CliToolPreference(useLeoApiKey = true)
        fun resolve(type: ProviderType, credential: ProviderCredential) =
            CliToolLaunchResolver.resolveCredential(
                spec,
                pref,
                LeoCliCredential(type, credential, false, apiKey = "key", modelId = "model"),
            ) as CliLaunchResolution.Failed

        assertEquals(CliLaunchError.PROVIDER_MISMATCH, resolve(ProviderType.openAI, ProviderCredential.apiKey).error)
        assertEquals(CliLaunchError.OAUTH_NOT_EXPORTABLE, resolve(ProviderType.anthropic, ProviderCredential.oauth).error)
    }

    @Test
    fun claudeCustomEndpointUsesGatewayConfigWithoutPersistingSecret() {
        val result = CliToolLaunchResolver.resolveCredential(
            CliToolCatalog.get(CliToolId.CLAUDE),
            CliToolPreference(useLeoApiKey = true),
            LeoCliCredential(
                providerType = ProviderType.anthropic,
                credentialType = ProviderCredential.apiKey,
                hasCustomEndpoint = true,
                baseUrl = "https://gateway.example/v1",
                apiKey = "secret-canary",
                modelId = "claude-custom",
                providerLabel = "My Gateway",
            ),
        ) as CliLaunchResolution.Ready

        assertEquals("https://gateway.example", result.request.environment["ANTHROPIC_BASE_URL"])
        assertEquals("secret-canary", result.request.environment["ANTHROPIC_AUTH_TOKEN"])
        assertEquals("claude-custom", result.request.environment["ANTHROPIC_MODEL"])
        assertEquals("/root/.leophone-cli/claude", result.request.environment["CLAUDE_CONFIG_DIR"])
        assertFalse(result.request.command.contains("--settings"))
        assertTrue(result.request.managedConfig!!.preserveExisting)
        assertTrue(result.request.managedConfig!!.content.contains("hasCompletedOnboarding"))
        assertFalse(result.request.managedConfig!!.content.contains("claude-custom"))
        assertFalse(result.request.command.contains("secret-canary"))
        assertFalse(result.request.managedConfig!!.content.contains("secret-canary"))
    }

    @Test
    fun codexRequiresResponsesButBuildsASecretFreeProfileWhenCompatible() {
        val spec = CliToolCatalog.get(CliToolId.CODEX)
        val incompatible = CliToolLaunchResolver.resolveCredential(
            spec,
            CliToolPreference(useLeoApiKey = true),
            LeoCliCredential(
                ProviderType.openAI, ProviderCredential.apiKey, true,
                baseUrl = "https://chat-only.example/v1",
                apiKey = "secret", modelId = "gpt-custom",
            ),
        ) as CliLaunchResolution.Failed
        assertEquals(CliLaunchError.INCOMPATIBLE_PROTOCOL, incompatible.error)

        val ready = CliToolLaunchResolver.resolveCredential(
            spec,
            CliToolPreference(useLeoApiKey = true),
            LeoCliCredential(
                ProviderType.openAI, ProviderCredential.apiKey, true,
                baseUrl = "https://responses.example/v1", useResponsesAPI = true,
                apiKey = "secret-canary", modelId = "gpt-custom",
            ),
        ) as CliLaunchResolution.Ready
        assertEquals("secret-canary", ready.request.environment["LEOPHONE_CLI_API_KEY"])
        assertEquals("/root/.leophone-cli/codex", ready.request.environment["CODEX_HOME"])
        assertTrue(ready.request.command.contains("--profile"))
        assertTrue(ready.request.managedConfig!!.content.contains("wire_api = \"responses\""))
        assertFalse(ready.request.managedConfig!!.content.contains("secret-canary"))
    }

    @Test
    fun grokSupportsOpenAiAndAnthropicCompatibleLeoModels() {
        fun resolve(type: ProviderType, responses: Boolean = false) =
            CliToolLaunchResolver.resolveCredential(
                CliToolCatalog.get(CliToolId.GROK),
                CliToolPreference(useLeoApiKey = true),
                LeoCliCredential(
                    type, ProviderCredential.apiKey, true,
                    baseUrl = "https://gateway.example/v1", useResponsesAPI = responses,
                    apiKey = "secret", modelId = "model-x",
                ),
            ) as CliLaunchResolution.Ready

        assertTrue(resolve(ProviderType.anthropic).request.managedConfig!!.content.contains("api_backend = \"messages\""))
        assertTrue(resolve(ProviderType.openAI).request.managedConfig!!.content.contains("api_backend = \"chat_completions\""))
        assertTrue(resolve(ProviderType.xAI, true).request.managedConfig!!.content.contains("api_backend = \"responses\""))
    }

    @Test
    fun cursorKeepsOfficialLoginBoundaryAndAllLoginCommandsAreExplicit() {
        val cursor = CliToolLaunchResolver.resolveCredential(
            CliToolCatalog.get(CliToolId.CURSOR),
            CliToolPreference(useLeoApiKey = true),
            LeoCliCredential(
                ProviderType.openAI, ProviderCredential.apiKey, false,
                apiKey = "secret", modelId = "gpt",
            ),
        ) as CliLaunchResolution.Failed
        assertEquals(CliLaunchError.UNSUPPORTED, cursor.error)

        assertTrue(CliToolCatalog.get(CliToolId.CLAUDE).loginCommand.contains("auth login"))
        assertTrue(CliToolCatalog.get(CliToolId.CODEX).loginCommand.contains("codex login"))
        assertTrue(CliToolCatalog.get(CliToolId.CURSOR).loginCommand.contains("agent login"))
        assertTrue(CliToolCatalog.get(CliToolId.GROK).loginCommand.contains("--device-auth"))
    }

    @Test
    fun externalHttpEndpointsFailClosedButLoopbackHttpIsAllowed() {
        fun resolve(base: String) = CliToolLaunchResolver.resolveCredential(
            CliToolCatalog.get(CliToolId.CLAUDE),
            CliToolPreference(useLeoApiKey = true),
            LeoCliCredential(
                ProviderType.anthropic, ProviderCredential.apiKey, true,
                baseUrl = base, apiKey = "secret", modelId = "model",
            ),
        )
        assertEquals(CliLaunchError.UNSAFE_ENDPOINT, (resolve("http://evil.example") as CliLaunchResolution.Failed).error)
        assertTrue(resolve("http://127.0.0.1:9000/v1") is CliLaunchResolution.Ready)
    }

    @Test
    fun managedConfigPathsStayInsideThePrivateLeoDirectory() {
        assertTrue(CliManagedConfigWriter.isAllowedGuestPath("/root/.leophone-cli/codex/leophone.config.toml"))
        assertFalse(CliManagedConfigWriter.isAllowedGuestPath("/root/.leophone-cli/../.ssh/config"))
        assertFalse(CliManagedConfigWriter.isAllowedGuestPath("/root/.codex/config.toml"))
    }
}
