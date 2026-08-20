package com.leoyuan.leophoneagent.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdaptiveLayoutPolicyTest {
    private fun arrangement(widthDp: Float, heightDp: Float, posture: FoldPosture) =
        workspaceLayoutOf(widthDp, heightDp, posture).arrangement

    @Test
    fun `Fold inner display uses two panes`() {
        assertTrue(shouldUseFoldableTwoPane(widthDp = 674f, heightDp = 841f))
        assertEquals(WorkspaceArrangement.LEFT_RIGHT, arrangement(674f, 841f, FoldPosture.NONE))
    }

    @Test
    fun `Fold cover display uses one pane`() {
        assertFalse(shouldUseFoldableTwoPane(widthDp = 344f, heightDp = 760f))
        assertEquals(WorkspaceArrangement.SINGLE, arrangement(344f, 760f, FoldPosture.NONE))
        assertEquals(WorkspaceArrangement.SINGLE, arrangement(344f, 760f, FoldPosture.TABLETOP))
        assertEquals(WorkspaceArrangement.SINGLE, arrangement(344f, 760f, FoldPosture.BOOK))
    }

    @Test
    fun `split screen and shallow landscape remain one pane`() {
        assertFalse(shouldUseFoldableTwoPane(widthDp = 599f, heightDp = 841f))
        assertFalse(shouldUseFoldableTwoPane(widthDp = 800f, heightDp = 479f))
        assertEquals(WorkspaceArrangement.SINGLE, arrangement(599f, 841f, FoldPosture.NONE))
        assertEquals(WorkspaceArrangement.SINGLE, arrangement(800f, 479f, FoldPosture.BOOK))
    }

    @Test
    fun `HALF_OPENED tabletop is top-bottom not left-right`() {
        assertEquals(FoldPosture.TABLETOP, foldPostureOf(halfOpened = true, horizontalHinge = true))
        assertEquals(WorkspaceArrangement.TOP_BOTTOM, arrangement(674f, 841f, FoldPosture.TABLETOP))
    }

    @Test
    fun `HALF_OPENED book keeps two panes when the window is wide enough`() {
        assertEquals(FoldPosture.BOOK, foldPostureOf(halfOpened = true, horizontalHinge = false))
        assertEquals(WorkspaceArrangement.LEFT_RIGHT, arrangement(674f, 841f, FoldPosture.BOOK))
    }

    @Test
    fun `FLAT hinge does not override the window-size rule`() {
        assertEquals(FoldPosture.NONE, foldPostureOf(halfOpened = false, horizontalHinge = true))
        assertEquals(FoldPosture.NONE, foldPostureOf(halfOpened = false, horizontalHinge = false))
        assertEquals(WorkspaceArrangement.LEFT_RIGHT, arrangement(674f, 841f, FoldPosture.NONE))
    }

    @Test
    fun `unknown posture stays single pane so tabletop cannot flash left-right`() {
        val decision = workspaceLayoutOf(674f, 841f, FoldPosture.UNKNOWN)
        assertEquals(WorkspaceArrangement.SINGLE, decision.arrangement)
        assertEquals(WorkspaceArrangement.SINGLE, arrangement(674f, 841f, FoldPosture.UNKNOWN))
    }

    @Test
    fun `tabletop uses top-bottom split and hinge band when provided`() {
        val fallback = workspaceLayoutOf(674f, 841f, FoldPosture.TABLETOP)
        assertEquals(WorkspaceArrangement.TOP_BOTTOM, fallback.arrangement)
        assertEquals(0.5f, fallback.hinge?.startFraction)
        assertEquals(0.5f, fallback.hinge?.endFraction)

        val hinged = workspaceLayoutOf(
            674f,
            841f,
            FoldPosture.TABLETOP,
            HingeBand(0.42f, 0.47f),
        )
        assertEquals(WorkspaceArrangement.TOP_BOTTOM, hinged.arrangement)
        assertEquals(0.42f, hinged.hinge?.startFraction)
        assertEquals(0.47f, hinged.hinge?.endFraction)
    }

    @Test
    fun `book uses left-right and keeps provided vertical hinge band`() {
        val hinged = workspaceLayoutOf(
            674f,
            841f,
            FoldPosture.BOOK,
            HingeBand(0.48f, 0.52f),
        )
        assertEquals(WorkspaceArrangement.LEFT_RIGHT, hinged.arrangement)
        assertEquals(0.48f, hinged.hinge?.startFraction)
        assertEquals(0.52f, hinged.hinge?.endFraction)
        assertEquals(0.5f, hinged.hinge?.midFraction)
    }

    @Test
    fun `large font on a narrow half-pane falls back to single`() {
        val cramped = workspaceLayoutOf(674f, 841f, FoldPosture.NONE, fontScale = 2f)
        assertEquals(WorkspaceArrangement.SINGLE, cramped.arrangement)
        assertTrue(shouldFallbackFromCrampedTwoPane(674f, 841f, 2f))
        assertFalse(shouldFallbackFromCrampedTwoPane(674f, 841f, 1f))
    }

    @Test
    fun `hinge band converts pixel bounds to fractions`() {
        val band = hingeBandFromPixels(startPx = 400, endPx = 420, totalPx = 800)
        assertEquals(0.5f, band?.startFraction)
        assertEquals(0.525f, band?.endFraction)
        assertEquals(null, hingeBandFromPixels(10, 20, 0))
    }
}
