package com.leoyuan.leophoneagent.sandbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CliChatEngineTest {
    private val sessionUuid = "123e4567-e89b-12d3-a456-426614174000"

    @Test
    fun `commands reference prompt file without embedding prompt or secrets`() {
        val promptPath = "/var/minis/workspace/.leo-cli/prompt-1.txt"
        CliToolId.entries.forEach { id ->
            val command = CliChatCommand.build(
                CliToolCatalog.get(id),
                CliToolPreference(model = "safe-model"),
                promptPath,
                sessionUuid,
            )
            assertTrue(command.contains(promptPath))
            assertTrue(command.contains("safe-model"))
            assertFalse(command.contains("API_KEY="))
            assertFalse(command.contains("user secret prompt"))
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun `prompt path traversal is rejected`() {
        CliChatCommand.build(
            CliToolCatalog.get(CliToolId.CLAUDE),
            CliToolPreference(),
            "/var/minis/workspace/.leo-cli/../secret",
            sessionUuid,
        )
    }

    @Test
    fun `cli continuation is isolated by explicit per-chat identity`() {
        val claude = CliChatCommand.build(
            CliToolCatalog.get(CliToolId.CLAUDE), CliToolPreference(),
            "/var/minis/workspace/.leo-cli/prompt.txt", sessionUuid,
        )
        val grok = CliChatCommand.build(
            CliToolCatalog.get(CliToolId.GROK), CliToolPreference(),
            "/var/minis/workspace/.leo-cli/prompt.txt", sessionUuid,
        )
        assertTrue(claude.contains("--session-id '$sessionUuid'"))
        assertTrue(claude.contains("--resume '$sessionUuid'"))
        assertTrue(grok.contains("--session-id '$sessionUuid'"))
        assertTrue(grok.contains("--resume '$sessionUuid'"))
        assertFalse(claude.contains("--continue"))
        assertFalse(grok.contains("--continue"))
    }

    @Test
    fun `managed profile arguments are shell quoted and never include credentials`() {
        val command = CliChatCommand.build(
            CliToolCatalog.get(CliToolId.CLAUDE),
            CliToolPreference(model = "model-x"),
            "/var/minis/workspace/.leo-cli/prompt.txt",
            sessionUuid,
            extraArguments = listOf("--settings", "/root/.leophone-cli/claude-settings.json"),
        )
        assertTrue(command.contains("'--settings' '/root/.leophone-cli/claude-settings.json'"))
        assertFalse(command.contains("secret"))
    }

    @Test
    fun `claude partial frames are monotonic and whole message is deduplicated`() {
        val decoder = CliStreamDecoder(CliToolId.CLAUDE)
        assertEquals(
            listOf("Hel"),
            decoder.accept("""{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}"""),
        )
        assertEquals(
            listOf("lo"),
            decoder.accept("""{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}"""),
        )
        assertEquals(
            emptyList<String>(),
            decoder.accept("""{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}"""),
        )
        assertEquals("Hello", decoder.accumulatedText)
    }

    @Test
    fun `codex completed agent message is decoded`() {
        val decoder = CliStreamDecoder(CliToolId.CODEX)
        assertEquals(
            listOf("Done"),
            decoder.accept("""{"type":"item.completed","item":{"type":"agent_message","text":"Done"}}"""),
        )
    }
}
