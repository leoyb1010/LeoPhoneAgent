package com.leoyuan.leophoneagent.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdaptiveLayoutPolicyTest {
    @Test
    fun `Fold inner display uses two panes`() {
        assertTrue(shouldUseFoldableTwoPane(widthDp = 674f, heightDp = 841f))
        assertTrue(shouldUseTwoPaneWorkspace(674f, 841f, FoldPosture.NONE))
    }

    @Test
    fun `Fold cover display uses one pane`() {
        assertFalse(shouldUseFoldableTwoPane(widthDp = 344f, heightDp = 760f))
        assertFalse(shouldUseTwoPaneWorkspace(344f, 760f, FoldPosture.NONE))
        assertFalse(shouldUseTwoPaneWorkspace(344f, 760f, FoldPosture.TABLETOP))
        assertFalse(shouldUseTwoPaneWorkspace(344f, 760f, FoldPosture.BOOK))
    }

    @Test
    fun `split screen and shallow landscape remain one pane`() {
        assertFalse(shouldUseFoldableTwoPane(widthDp = 599f, heightDp = 841f))
        assertFalse(shouldUseFoldableTwoPane(widthDp = 800f, heightDp = 479f))
        assertFalse(shouldUseTwoPaneWorkspace(599f, 841f, FoldPosture.NONE))
        assertFalse(shouldUseTwoPaneWorkspace(800f, 479f, FoldPosture.BOOK))
    }

    @Test
    fun `HALF_OPENED tabletop stays one pane so the hinge does not cut the composer`() {
        assertEquals(FoldPosture.TABLETOP, foldPostureOf(halfOpened = true, horizontalHinge = true))
        assertFalse(shouldUseTwoPaneWorkspace(674f, 841f, FoldPosture.TABLETOP))
    }

    @Test
    fun `HALF_OPENED book keeps two panes when the window is wide enough`() {
        assertEquals(FoldPosture.BOOK, foldPostureOf(halfOpened = true, horizontalHinge = false))
        assertTrue(shouldUseTwoPaneWorkspace(674f, 841f, FoldPosture.BOOK))
    }

    @Test
    fun `FLAT hinge does not override the window-size rule`() {
        assertEquals(FoldPosture.NONE, foldPostureOf(halfOpened = false, horizontalHinge = true))
        assertEquals(FoldPosture.NONE, foldPostureOf(halfOpened = false, horizontalHinge = false))
        assertTrue(shouldUseTwoPaneWorkspace(674f, 841f, FoldPosture.NONE))
    }
}
