package com.leoyuan.leophoneagent.ui.chat

import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PastePlaceholderTest {
    @Test fun `long Chinese paste folds and expands without recursive replacement`() {
        val inserted = "中".repeat(1201) + " [Pasted#2]"
        val buffer = mutableListOf<PastedText>()
        val folded = foldLongPasteIfNeeded(TextFieldValue("before "), TextFieldValue("before $inserted")) {
            PastedText(1, it).also(buffer::add).placeholder
        }
        assertEquals("before [Pasted#1]", folded.text)
        assertEquals(TextRange(folded.text.length), folded.selection)
        assertEquals("before $inserted", expandPastePlaceholders(folded.text, buffer).first)
    }

    @Test fun `English threshold uses words and unknown marker is preserved`() {
        assertTrue(isLongPastedText((1..1001).joinToString(" ") { "word" }))
        assertFalse(isLongPastedText((1..1000).joinToString(" ") { "word" }))
        assertEquals("[Pasted#99]", expandPastePlaceholders("[Pasted#99]", listOf(PastedText(1, "x"))).first)
    }
}
