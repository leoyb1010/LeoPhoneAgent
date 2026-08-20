package com.leoyuan.leophoneagent.ui.navigation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceLayoutStoreTest {
    @Test
    fun `store reports fold posture and window size for android-device`() {
        WorkspaceLayoutStore.update(
            FoldPosture.TABLETOP,
            674f,
            841f,
            WorkspaceLayoutDecision(WorkspaceArrangement.TOP_BOTTOM, HingeBand(0.5f, 0.5f)),
        )
        assertEquals("tabletop", WorkspaceLayoutStore.postureName)
        assertEquals(674f, WorkspaceLayoutStore.widthDp, 0.01f)
        assertEquals(841f, WorkspaceLayoutStore.heightDp, 0.01f)
        assertFalse(WorkspaceLayoutStore.twoPane)
        assertEquals("top_bottom", WorkspaceLayoutStore.arrangementName)

        WorkspaceLayoutStore.update(
            FoldPosture.NONE,
            674f,
            841f,
            WorkspaceLayoutDecision(WorkspaceArrangement.LEFT_RIGHT, HingeBand(0.48f, 0.52f)),
        )
        assertEquals("none", WorkspaceLayoutStore.postureName)
        assertTrue(WorkspaceLayoutStore.twoPane)
        assertEquals("left_right", WorkspaceLayoutStore.arrangementName)

        WorkspaceLayoutStore.update(
            FoldPosture.UNKNOWN,
            344f,
            760f,
            WorkspaceLayoutDecision(WorkspaceArrangement.SINGLE, null),
        )
        assertEquals("unknown", WorkspaceLayoutStore.postureName)
        assertEquals(344f, WorkspaceLayoutStore.widthDp, 0.01f)
        assertFalse(WorkspaceLayoutStore.twoPane)
        assertEquals("single", WorkspaceLayoutStore.arrangementName)
    }
}
