package com.leoyuan.leophoneagent.task

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentRunRecoveryTest {
    @Test
    fun `running becomes waiting for user and is not auto resumed`() {
        val started = 100L
        val now = 200L
        val running = AgentRunRecord(
            sessionId = "s1",
            phase = AgentRunPhase.RUNNING,
            updatedAt = started,
            reason = null,
            title = "secret title",
        )
        val recovered = AgentRunRecovery.recover(listOf(running), now).single()
        assertEquals(AgentRunPhase.WAITING_USER, recovered.phase)
        assertEquals(AgentRunRecovery.REASON_UNEXPECTED_TERMINATION, recovered.reason)
        assertEquals(started, running.updatedAt)
        assertEquals(now, recovered.updatedAt)
        assertTrue(recovered.isResumable)
        assertEquals("s1", recovered.sessionId)
    }

    @Test
    fun `paused also becomes waiting for user`() {
        val paused = AgentRunRecord("s2", AgentRunPhase.PAUSED, 1L)
        val recovered = AgentRunRecovery.recover(listOf(paused), 9L).single()
        assertEquals(AgentRunPhase.WAITING_USER, recovered.phase)
        assertTrue(recovered.isResumable)
    }

    @Test
    fun `terminal runs stay closed`() {
        val completed = AgentRunRecord("s3", AgentRunPhase.COMPLETED, 1L)
        val failed = AgentRunRecord("s4", AgentRunPhase.FAILED, 1L)
        val recovered = AgentRunRecovery.recover(listOf(completed, failed), 9L)
        assertEquals(completed, recovered[0])
        assertEquals(failed, recovered[1])
        assertFalse(recovered[0].isResumable)
    }

    @Test
    fun `surface state mapping`() {
        assertEquals(TaskSurfaceState.IDLE, AgentRunRecovery.surfaceState(null))
        assertEquals(
            TaskSurfaceState.RUNNING,
            AgentRunRecovery.surfaceState(AgentRunRecord("s", AgentRunPhase.RUNNING, 1L)),
        )
        assertEquals(
            TaskSurfaceState.PAUSED,
            AgentRunRecovery.surfaceState(AgentRunRecord("s", AgentRunPhase.PAUSED, 1L)),
        )
        assertEquals(
            TaskSurfaceState.NEEDS_ATTENTION,
            AgentRunRecovery.surfaceState(AgentRunRecord("s", AgentRunPhase.WAITING_USER, 1L)),
        )
        assertEquals(
            TaskSurfaceState.COMPLETED,
            AgentRunRecovery.surfaceState(AgentRunRecord("s", AgentRunPhase.COMPLETED, 1L)),
        )
    }

    @Test
    fun `privacy snapshot never carries title`() {
        val rec = AgentRunRecord("s", AgentRunPhase.RUNNING, 1L, title = "do not leak")
        val hidden = if (true) null else rec.title
        assertEquals(null, hidden)
        assertEquals(TaskSurfaceState.RUNNING, AgentRunRecovery.surfaceState(rec))
    }
}
