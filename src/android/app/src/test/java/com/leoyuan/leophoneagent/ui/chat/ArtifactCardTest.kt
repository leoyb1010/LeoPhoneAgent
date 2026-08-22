package com.leoyuan.leophoneagent.ui.chat

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ArtifactCardTest {
    @Test
    fun `successful previewable file write becomes artifact`() {
        val block = AssistantBlock(
            id = "tool-1",
            kind = "tool_use",
            toolName = "file_write",
            toolArgs = JSONObject().put("path", "/var/minis/workspace/report.html").toString(),
            toolStatus = ToolBlockStatus.SUCCESS,
        )

        assertEquals(
            ChatArtifact("/var/minis/workspace/report.html", "report.html", "html"),
            artifactFromToolBlock(block),
        )
    }

    @Test
    fun `source edit and unfinished write do not create noisy cards`() {
        val source = AssistantBlock(
            id = "tool-2",
            kind = "tool_use",
            toolName = "file_write",
            toolArgs = JSONObject().put("path", "/var/minis/workspace/App.kt").toString(),
            toolStatus = ToolBlockStatus.SUCCESS,
        )
        val running = source.copy(
            toolArgs = JSONObject().put("path", "/var/minis/workspace/report.pdf").toString(),
            toolStatus = ToolBlockStatus.RUNNING,
        )

        assertNull(artifactFromToolBlock(source))
        assertNull(artifactFromToolBlock(running))
    }

    @Test
    fun `malformed tool arguments fail closed`() {
        val block = AssistantBlock(
            id = "tool-3",
            kind = "tool_use",
            toolName = "file_write",
            toolArgs = "not-json",
            toolStatus = ToolBlockStatus.SUCCESS,
        )

        assertNull(artifactFromToolBlock(block))
    }

    @Test
    fun `artifact preview rejects traversal and paths outside product roots`() {
        val base = AssistantBlock(
            id = "tool-4",
            kind = "tool_use",
            toolName = "file_write",
            toolStatus = ToolBlockStatus.SUCCESS,
        )
        assertNull(
            artifactFromToolBlock(
                base.copy(toolArgs = JSONObject().put("path", "/var/minis/workspace/../memory/secret.pdf").toString()),
            ),
        )
        assertNull(
            artifactFromToolBlock(
                base.copy(toolArgs = JSONObject().put("path", "/root/private.pdf").toString()),
            ),
        )
    }
}
