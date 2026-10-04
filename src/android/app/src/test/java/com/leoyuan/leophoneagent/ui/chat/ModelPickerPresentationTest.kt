package com.leoyuan.leophoneagent.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelPickerPresentationTest {
    private val members = listOf("first", "second")
    private val available = members.toSet()

    @Test fun `selected group shows the actual second member after explicit choice or fallback`() {
        assertEquals("second", modelGroupPreviewEntryId(members, available, true, "second"))
    }

    @Test fun `other groups preview their own members and cannot borrow the current model`() {
        assertEquals("first", modelGroupPreviewEntryId(members, available, false, "second"))
        assertNull(modelGroupPreviewEntryId(listOf("missing"), available, false, "second"))
    }

    @Test fun `missing active model falls back to the first remaining member for display only`() {
        assertEquals("second", modelGroupPreviewEntryId(members, setOf("second"), true, "missing"))
        assertNull(modelGroupPreviewEntryId(members, emptySet(), true, "missing"))
    }

    @Test fun `current model survives a group membership refresh in display without changing routing`() {
        assertEquals("second", modelGroupPreviewEntryId(emptyList(), available, true, "second"))
    }

    @Test fun `shared entry is active only inside the selected group`() {
        assertTrue(isActiveModelGroupEntry("chosen", "chosen", "second", "second"))
        assertFalse(isActiveModelGroupEntry("other", "chosen", "second", "second"))
        assertFalse(isActiveModelGroupEntry("chosen", null, "second", "second"))
        assertFalse(isActiveModelGroupEntry("chosen", "chosen", "first", "second"))
    }

    @Test fun `search exposes every matching row without changing the stored collapse preference`() {
        val collapsed = setOf("provider")
        assertTrue(isModelProviderCollapsed("provider", collapsed, ""))
        assertFalse(isModelProviderCollapsed("provider", collapsed, "gpt"))
        assertTrue(isModelProviderCollapsed("provider", collapsed, ""))
        assertEquals(setOf("provider"), collapsed)
        assertFalse(isModelProviderCollapsed("other", collapsed, ""))
    }

    @Test fun `pasted query spacing and empty whitespace retain useful matching`() {
        assertTrue(modelPickerMatches("GPT-5 Mini", "  gpt-5  "))
        assertTrue(modelPickerMatches("Claude Sonnet", "csnt"))
        assertTrue(modelPickerMatches("DeepSeek", " \t "))
        assertTrue(isModelProviderCollapsed("provider", setOf("provider"), " \t "))
        assertFalse(modelPickerMatches("GPT-5 Mini", "zzzz"))
    }
}
