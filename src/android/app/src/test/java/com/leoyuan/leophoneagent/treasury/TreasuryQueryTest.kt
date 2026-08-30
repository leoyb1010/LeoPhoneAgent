package com.leoyuan.leophoneagent.treasury

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TreasuryQueryTest {
    @Test
    fun `parser separates exact filters from FTS text`() {
        val spec = TreasuryQuery.parse(
            "离线 阅读 type:link,document state:ready,partial read:unread tag:资料 is:pinned after:2026-01-02 before:2026-02-03"
        )
        assertEquals("离线 阅读", spec.textQuery)
        assertEquals(setOf("link", "document"), spec.kinds)
        assertEquals(setOf("ready", "partial"), spec.processingStates)
        assertEquals(setOf("unread"), spec.readingStates)
        assertEquals(setOf("资料"), spec.tags)
        assertEquals(true, spec.pinned)
        assertTrue(spec.afterEpochMs!! < spec.beforeEpochMs!!)
    }

    @Test
    fun `unknown and malformed filters remain searchable text`() {
        val spec = TreasuryQuery.parse("topic:agent type:unknown before:not-a-date is:graph")
        assertEquals("topic:agent type:unknown before:not-a-date is:graph", spec.textQuery)
        assertTrue(spec.kinds.isEmpty())
        assertFalse(spec.archived)
    }

    @Test
    fun `archived and recent views are explicit`() {
        val spec = TreasuryQuery.parse("is:archived is:recent")
        assertTrue(spec.archived)
        assertTrue(spec.recent)
        assertEquals("", spec.textQuery)
    }
}
