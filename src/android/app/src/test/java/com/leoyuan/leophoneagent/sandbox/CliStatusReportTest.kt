package com.leoyuan.leophoneagent.sandbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CliStatusReportTest {

    @Test
    fun parsesInstalledAndMissingToolsFromMarkerLines() {
        val output = """
            random installer noise
            ___LEO_CLI___ CLAUDE 0 2.1.238 (Claude Code)
            ___LEO_CLI___ CODEX 127
            ___LEO_CLI___ GROK 0 grok 1.0.5 (5115b46bc9)
            ___LEO_CLI___ CURSOR 1 some error text
        """.trimIndent()

        val parsed = CliStatusReport.parse(output)
        assertTrue(parsed.getValue(CliToolId.CLAUDE).installed)
        assertEquals("2.1.238 (Claude Code)", parsed.getValue(CliToolId.CLAUDE).version)
        assertFalse(parsed.getValue(CliToolId.CODEX).installed)
        assertTrue(parsed.getValue(CliToolId.GROK).installed)
        // Non-zero exit must never read as installed — no piped fake green.
        assertFalse(parsed.getValue(CliToolId.CURSOR).installed)
        assertNull(parsed.getValue(CliToolId.CURSOR).version)
    }

    @Test
    fun everyCatalogToolGetsARowEvenWhenTheProbeDiesHalfway() {
        val parsed = CliStatusReport.parse("___LEO_CLI___ CLAUDE 0 2.1.238")
        assertEquals(CliToolId.entries.toSet(), parsed.keys)
        assertFalse(parsed.getValue(CliToolId.CURSOR).installed)
    }

    @Test
    fun garbageMarkerLinesAreIgnoredNotCrashed() {
        val parsed = CliStatusReport.parse(
            "___LEO_CLI___\n___LEO_CLI___ NOT_A_TOOL 0 x\n___LEO_CLI___ CLAUDE notanumber y",
        )
        assertFalse(parsed.getValue(CliToolId.CLAUDE).installed)
    }

    @Test
    fun combinedCommandProbesEveryToolWithRealExitCodes() {
        val command = CliToolCatalog.combinedStatusCommand()
        CliToolCatalog.tools.forEach { tool ->
            assertTrue(command.contains("'${tool.binaryPath}'"))
            assertTrue(command.contains(tool.id.name))
        }
        assertTrue(command.contains("rc=${'$'}?"))
        assertFalse(command.contains("|| true"))
    }
}
