package com.leoyuan.leophoneagent.sandbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CliToolCatalogTest {
    @Test
    fun catalogContainsTheFourOfficialArm64Tools() {
        assertEquals(CliToolId.entries.toSet(), CliToolCatalog.tools.map { it.id }.toSet())
        assertEquals(4, CliToolCatalog.tools.map { it.binaryPath }.toSet().size)
    }

    @Test
    fun installersAreHttpsAllowlistedAndSandboxScoped() {
        CliToolCatalog.tools.forEach { tool ->
            assertTrue(tool.installerUrl.startsWith("https://"))
            assertTrue(tool.sourceHost in CliToolCatalog.OFFICIAL_HOSTS)
            assertTrue(tool.binaryPath.startsWith("/root/"))
            assertFalse(tool.binaryPath.contains(".."))
        }
    }

    @Test
    fun installerCommandsEnforceTransportAndDownloadBounds() {
        CliToolCatalog.tools.forEach { tool ->
            val command = tool.installCommand()
            assertTrue(command.contains("--proto '=https'"))
            assertTrue(command.contains("export TMPDIR=/tmp"))
            assertTrue(command.contains("--proto-redir '=https'"))
            assertTrue(command.contains("--max-filesize 2097152"))
            assertTrue(command.contains("coreutils"))
            assertTrue(command.contains("hash -r"))
            assertTrue(command.contains("mktemp /tmp/leo-cli-installer."))
            assertTrue(command.contains("test -x '${tool.binaryPath}'"))
            assertFalse(command.contains("curl -fsSL ${tool.installerUrl} |"))
        }
    }

    @Test
    fun statusAndTerminalCommandsUseCatalogBinariesOnly() {
        CliToolCatalog.tools.forEach { tool ->
            assertTrue(tool.statusCommand().contains("'${tool.binaryPath}'"))
            assertTrue(tool.statusCommand().contains("|| exit ${'$'}?"))
            assertFalse(tool.terminalCommand.contains('\n'))
        }
    }

    @Test
    fun modelOverrideIsShellQuotedAndBounded() {
        val codex = CliToolCatalog.get(CliToolId.CODEX)
        val command = codex.launchCommand("gpt-test'; rm -rf /")
        assertTrue(command.endsWith("'--model' 'gpt-test'\\''; rm -rf /'"))
        runCatching { codex.launchCommand("x".repeat(201)) }
            .onSuccess { throw AssertionError("oversized model id was accepted") }
        runCatching { codex.launchCommand("bad\nmodel") }
            .onSuccess { throw AssertionError("control character was accepted") }
    }

    @Test
    fun cursorCompatibilityDependencyIsVersionAndDigestPinned() {
        val cursor = CliToolCatalog.get(CliToolId.CURSOR)
        val command = cursor.installCommand()
        assertTrue(command.contains("node-addon-api-8.9.2.tgz"))
        assertTrue(command.contains("gcompat"))
        assertTrue(command.contains("5628cb5db8b750008debd2342555c9b17e2d8c00"))
        assertTrue(command.contains("sha512sum -c"))
        assertTrue(command.contains("libleo-cursor-glibc.so"))
        assertTrue(command.contains("npm rebuild --build-from-source"))
        val syntax = ProcessBuilder("sh", "-n", "-c", command).start()
        assertEquals(0, syntax.waitFor())
    }
}
