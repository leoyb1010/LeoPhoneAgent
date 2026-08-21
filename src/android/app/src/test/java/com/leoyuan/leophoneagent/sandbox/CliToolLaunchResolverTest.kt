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

        assertEquals("secret-canary", result.request.environment["OPENAI_API_KEY"])
        assertTrue(result.request.command.contains("--model 'gpt-5.6'"))
        assertFalse(result.request.command.contains("secret-canary"))
    }

    @Test
    fun oauthCustomEndpointAndWrongProviderFailClosed() {
        val spec = CliToolCatalog.get(CliToolId.CLAUDE)
        val pref = CliToolPreference(useLeoApiKey = true)
        fun resolve(type: ProviderType, credential: ProviderCredential, custom: Boolean) =
            CliToolLaunchResolver.resolveCredential(
                spec,
                pref,
                LeoCliCredential(type, credential, custom, "key", "model"),
            ) as CliLaunchResolution.Failed

        assertEquals(CliLaunchError.PROVIDER_MISMATCH, resolve(ProviderType.openAI, ProviderCredential.apiKey, false).error)
        assertEquals(CliLaunchError.OAUTH_NOT_EXPORTABLE, resolve(ProviderType.anthropic, ProviderCredential.oauth, false).error)
        assertEquals(CliLaunchError.CUSTOM_ENDPOINT_UNSUPPORTED, resolve(ProviderType.anthropic, ProviderCredential.apiKey, true).error)
    }
}
