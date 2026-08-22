package com.leoyuan.leophoneagent.sandbox

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExecutionCoordinatorSecurityTest {
    @Test
    fun `transient environment accepts shell variable names only`() {
        assertTrue(ExecutionCoordinator.isValidEnvironmentKey("ANTHROPIC_API_KEY"))
        assertTrue(ExecutionCoordinator.isValidEnvironmentKey("_LEO_TOKEN_2"))
        assertFalse(ExecutionCoordinator.isValidEnvironmentKey("BAD-NAME"))
        assertFalse(ExecutionCoordinator.isValidEnvironmentKey("X; touch /tmp/pwn"))
        assertFalse(ExecutionCoordinator.isValidEnvironmentKey("2TOKEN"))
    }
}
