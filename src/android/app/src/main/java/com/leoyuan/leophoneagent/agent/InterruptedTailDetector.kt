package com.leoyuan.leophoneagent.agent

import com.leoyuan.leophoneagent.data.model.AgentContentPart
import com.leoyuan.leophoneagent.data.model.LLMMessage

/** Persisted tail shapes that can be resumed after cancellation or process death. */
enum class InterruptedTailShape {
    TOOL_RESULT_TAIL,
    ASSISTANT_TOOL_USE,
    CONTINUE_REMINDER,
    UNANSWERED_USER_TURN,
    NONE,
}

/**
 * Pure classifier shared by cold-start recovery and tests. Liveness is kept
 * outside this type: callers must still ensure that no request is streaming.
 */
object InterruptedTailDetector {
    const val CONTINUE_REMINDER_MARKER = "The user stopped the previous response"

    fun classify(lastEntry: LLMMessage?): InterruptedTailShape {
        if (lastEntry == null) return InterruptedTailShape.NONE
        return when (lastEntry.role) {
            LLMMessage.Role.USER -> {
                val parts = lastEntry.contentParts
                val allToolResults = parts.isNotEmpty() &&
                    parts.all { it is AgentContentPart.ToolResult }
                val isContinueReminder = parts.size == 1 &&
                    (parts.first() as? AgentContentPart.Text)?.text
                        ?.contains(CONTINUE_REMINDER_MARKER) == true
                when {
                    allToolResults -> InterruptedTailShape.TOOL_RESULT_TAIL
                    isContinueReminder -> InterruptedTailShape.CONTINUE_REMINDER
                    parts.isEmpty() -> InterruptedTailShape.NONE
                    else -> InterruptedTailShape.UNANSWERED_USER_TURN
                }
            }
            LLMMessage.Role.ASSISTANT ->
                if (lastEntry.contentParts.any { it is AgentContentPart.ToolUse }) {
                    InterruptedTailShape.ASSISTANT_TOOL_USE
                } else {
                    InterruptedTailShape.NONE
                }
        }
    }

    fun isInterrupted(lastEntry: LLMMessage?): Boolean =
        classify(lastEntry) != InterruptedTailShape.NONE
}
