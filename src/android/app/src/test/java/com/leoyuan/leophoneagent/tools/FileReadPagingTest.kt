package com.leoyuan.leophoneagent.tools

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FileReadPagingTest {

    private val lines = (1..20).map { "L$it" }

    @Test
    fun headPageEmitsNextOffset() {
        val page = FileReadPaging.page(lines, offset = 1, requestedLines = 5, maxLength = 15_000, direction = "head")
        assertEquals(1, page.showStart)
        assertEquals(5, page.showEnd)
        assertEquals(6, page.nextOffset)
        assertEquals("L1\nL2\nL3\nL4\nL5", page.content)
    }

    @Test
    fun lastPageOmitsNextOffset() {
        val page = FileReadPaging.page(lines, offset = 18, requestedLines = 10, maxLength = 15_000, direction = "head")
        assertEquals(18, page.showStart)
        assertEquals(20, page.showEnd)
        assertNull(page.nextOffset)
    }

    @Test
    fun maxLengthStopsOnLineBoundaryAndContinues() {
        val long = listOf("aaaa", "bbbb", "cccc", "dddd")
        val page = FileReadPaging.page(long, offset = 1, requestedLines = null, maxLength = 9, direction = "head")
        assertEquals("aaaa\nbbbb", page.content)
        assertEquals(2, page.showEnd)
        assertEquals(3, page.nextOffset)
        assertTrue(page.truncated)
    }

    @Test
    fun tailDoesNotEmitNextOffset() {
        val page = FileReadPaging.page(lines, offset = 1, requestedLines = 3, maxLength = 15_000, direction = "tail")
        assertEquals(18, page.showStart)
        assertEquals(20, page.showEnd)
        assertNull(page.nextOffset)
    }

    @Test
    fun formatIncludesNextOffsetLine() {
        val page = FileReadPaging.Page(1, 2, 10, "a\nb", false, 3)
        val out = FileReadPaging.formatOutput("/tmp/x", 4, page)
        assertTrue(out.contains("next_offset: 3"))
        assertTrue(out.contains("showing 1-2 of 10"))
    }
}
