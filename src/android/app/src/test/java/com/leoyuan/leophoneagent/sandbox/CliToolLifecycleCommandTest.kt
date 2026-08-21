package com.leoyuan.leophoneagent.sandbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CliToolLifecycleCommandTest {

    @Test
    fun uninstallRemovesOnlyTheLauncherBinary() {
        CliToolCatalog.tools.forEach { tool ->
            val command = tool.uninstallCommand()
            assertTrue(command.contains("rm -f '${tool.binaryPath}'"))
            // Login/config stay: no HOME-wide deletion may ever appear here.
            assertTrue(!command.contains("rm -rf"))
            assertTrue(command.contains("test ! -e '${tool.binaryPath}'"))
        }
    }

    @Test
    fun workdirLaunchIsQuotedAndSandboxScoped() {
        val claude = CliToolCatalog.get(CliToolId.CLAUDE)
        val command = claude.launchCommand(null, workdir = "/var/minis/mounts/my project")
        assertTrue(command.startsWith("cd '/var/minis/mounts/my project' && "))

        // Traversal, host paths and shell metacharacters must be rejected.
        listOf(
            "/var/minis/../etc",
            "/data/data/evil",
            "/root/x\nrm -rf /",
        ).forEach { bad ->
            runCatching { claude.launchCommand(null, workdir = bad) }
                .onSuccess { throw AssertionError("accepted bad workdir: $bad") }
        }
        // Quote-escape survives shellQuote (single quotes embedded).
        val quoted = claude.launchCommand(null, workdir = "/root/it's here")
        assertTrue(quoted.startsWith("cd '/root/it'\\''s here' && "))
    }

    @Test
    fun workdirAbsentKeepsLegacySingleArgBehavior() {
        val codex = CliToolCatalog.get(CliToolId.CODEX)
        assertEquals(codex.launchCommand("m1"), codex.launchCommand("m1", workdir = null))
        assertEquals(codex.terminalCommand, codex.launchCommand(null, workdir = "   "))
    }
}
