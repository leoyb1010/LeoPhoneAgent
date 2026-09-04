package com.leoyuan.leophoneagent.agent

import com.leoyuan.leophoneagent.data.model.AgentContentPart
import com.leoyuan.leophoneagent.data.model.LLMMessage
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InterruptedTailDetectorTest {
    private fun user(vararg parts: AgentContentPart) =
        LLMMessage(LLMMessage.Role.USER, "", contentParts = parts.toList())

    private fun assistant(vararg parts: AgentContentPart) =
        LLMMessage(LLMMessage.Role.ASSISTANT, "", contentParts = parts.toList())

    private fun text(value: String) = AgentContentPart.Text(value)
    private fun result(id: String = "r1") =
        AgentContentPart.ToolResult(id, "shell_execute", "ok")
    private fun use(id: String = "u1") =
        AgentContentPart.ToolUse(id, "shell_execute", JSONObject())

    @Test fun `plain user turn without reply is resumable`() {
        assertEquals(
            InterruptedTailShape.UNANSWERED_USER_TURN,
            InterruptedTailDetector.classify(user(text("hello"))),
        )
    }

    @Test fun `empty user turn is not resumable`() {
        assertFalse(InterruptedTailDetector.isInterrupted(user()))
    }

    @Test fun `tool and continue tails keep precise shapes`() {
        assertEquals(InterruptedTailShape.TOOL_RESULT_TAIL, InterruptedTailDetector.classify(user(result())))
        assertEquals(
            InterruptedTailShape.CONTINUE_REMINDER,
            InterruptedTailDetector.classify(user(text(InterruptedTailDetector.CONTINUE_REMINDER_MARKER))),
        )
        assertEquals(InterruptedTailShape.ASSISTANT_TOOL_USE, InterruptedTailDetector.classify(assistant(use())))
    }

    @Test fun `completed assistant reply is not resumable`() {
        assertFalse(InterruptedTailDetector.isInterrupted(assistant(text("done"))))
        assertTrue(InterruptedTailDetector.isInterrupted(user(result(), text("also explain"))))
    }
}
