package com.leoyuan.leophoneagent.auth

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OAuthStateValidationTest {
    @Test
    fun `matching non-null state is accepted`() {
        assertTrue(OAuthManager.secureStateMatches("expected-state", "expected-state"))
    }

    @Test
    fun `null missing and mismatched states are rejected`() {
        assertFalse(OAuthManager.secureStateMatches(null, null))
        assertFalse(OAuthManager.secureStateMatches("expected-state", null))
        assertFalse(OAuthManager.secureStateMatches(null, "expected-state"))
        assertFalse(OAuthManager.secureStateMatches("expected-state", "different-state"))
        assertFalse(OAuthManager.secureStateMatches("expected-state", "expected-state-extra"))
    }
}
