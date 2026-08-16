package com.leoyuan.leophoneagent.ui.navigation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdaptiveLayoutPolicyTest {
    @Test
    fun `Fold inner display uses two panes`() {
        assertTrue(shouldUseFoldableTwoPane(widthDp = 674f, heightDp = 841f))
    }

    @Test
    fun `Fold cover display uses one pane`() {
        assertFalse(shouldUseFoldableTwoPane(widthDp = 344f, heightDp = 760f))
    }

    @Test
    fun `split screen and shallow landscape remain one pane`() {
        assertFalse(shouldUseFoldableTwoPane(widthDp = 599f, heightDp = 841f))
        assertFalse(shouldUseFoldableTwoPane(widthDp = 800f, heightDp = 479f))
    }
}
