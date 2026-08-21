package com.leoyuan.leophoneagent.ui.settings

import com.leoyuan.leophoneagent.sandbox.CliToolId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CliToolsViewModelPolicyTest {

    @Test
    fun cursorGetsTheExtendedInstallCeiling() {
        assertEquals(20 * 60_000L, CliToolsViewModel.installTimeoutFor(CliToolId.CURSOR))
        listOf(CliToolId.CLAUDE, CliToolId.CODEX, CliToolId.GROK).forEach {
            assertEquals(10 * 60_000L, CliToolsViewModel.installTimeoutFor(it))
        }
    }

    @Test
    fun failureLogPrefersRollingLogAndStaysBounded() {
        assertEquals("l1\nl2", CliToolsViewModel.failureLog(listOf("l1", "l2"), "raw"))
        assertEquals("raw", CliToolsViewModel.failureLog(emptyList(), "  raw  "))
        val huge = List(500) { "line$it ${"x".repeat(100)}" }
        assertTrue(CliToolsViewModel.failureLog(huge, "").length <= 8000)
    }
}
