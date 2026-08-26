package com.leoyuan.leophoneagent.ui.settings

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsSearchTest {
    @Test
    fun emptyQueryShowsAll() {
        assertTrue(SettingsSearch.matches("", "远程机器", "审批"))
    }

    @Test
    fun matchesTitleOrSubtitle() {
        assertTrue(SettingsSearch.matches("审批", "远程机器", "远程发任务、看进度、审批和停止"))
        assertTrue(SettingsSearch.matches("mcp", "MCP", "Integrations"))
        assertFalse(SettingsSearch.matches("foobar", "Skills", "Agent"))
    }
}
