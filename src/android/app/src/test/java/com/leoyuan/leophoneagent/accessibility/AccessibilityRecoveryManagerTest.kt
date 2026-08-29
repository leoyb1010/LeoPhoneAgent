package com.leoyuan.leophoneagent.accessibility

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessibilityRecoveryManagerTest {
    private val pkg = "com.leoyuan.leophoneagent"
    private val service = "com.leoyuan.leophoneagent.accessibility.MinisAccessibilityService"

    @Test
    fun recognizesFullAndShortComponentWithoutDisablingPeerServices() {
        val peer = "com.google.android.marvin.talkback/.TalkBackService"
        assertFalse(AccessibilityRecoveryManager.isRevokedIn("$peer:$pkg/$service", pkg, service))
        assertFalse(AccessibilityRecoveryManager.isRevokedIn("$pkg/.accessibility.MinisAccessibilityService", pkg, service))
        assertTrue(AccessibilityRecoveryManager.isRevokedIn(peer, pkg, service))
        assertTrue(AccessibilityRecoveryManager.isRevokedIn(null, pkg, service))
    }
}
