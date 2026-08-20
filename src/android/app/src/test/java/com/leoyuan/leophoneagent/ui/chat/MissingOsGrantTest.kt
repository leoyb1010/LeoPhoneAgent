package com.leoyuan.leophoneagent.ui.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MissingOsGrantTest {
    @Test
    fun `no banner when idle and no tool hint`() {
        assertNull(
            detectMissingOsGrant(
                runActive = false,
                toolHint = null,
                overlayGranted = false,
                listenerGranted = false,
                allFilesGranted = false,
                a11yGranted = false,
                shizukuReady = false,
                micGranted = false,
                powerEdition = true,
            ),
        )
    }

    @Test
    fun `notification tool without listener surfaces listener grant`() {
        assertEquals(
            MissingOsGrant.LISTENER,
            detectMissingOsGrant(
                runActive = true,
                toolHint = "android-notification list",
                overlayGranted = true,
                listenerGranted = false,
                allFilesGranted = true,
                a11yGranted = true,
                shizukuReady = true,
                micGranted = true,
                powerEdition = true,
            ),
        )
    }

    @Test
    fun `speech tool without mic surfaces microphone grant`() {
        assertEquals(
            MissingOsGrant.MIC,
            detectMissingOsGrant(
                runActive = true,
                toolHint = "android-speech listen",
                overlayGranted = true,
                listenerGranted = true,
                allFilesGranted = true,
                a11yGranted = true,
                shizukuReady = true,
                micGranted = false,
                powerEdition = true,
            ),
        )
    }

    @Test
    fun `shizuku hint is ignored on Standard`() {
        assertNull(
            detectMissingOsGrant(
                runActive = true,
                toolHint = "android-shizuku-cli",
                overlayGranted = true,
                listenerGranted = true,
                allFilesGranted = true,
                a11yGranted = true,
                shizukuReady = false,
                micGranted = true,
                powerEdition = false,
            ),
        )
    }

    @Test
    fun `tool hint is taken from the latest assistant tool blocks`() {
        val messages = listOf(
            ChatMessage("1", "user", "open wechat"),
            ChatMessage(
                "2",
                "assistant",
                "",
                toolBlocks = listOf(
                    AssistantBlock(
                        id = "t1",
                        kind = "tool_use",
                        toolName = "shell_execute",
                        content = "android-notification list",
                    ),
                ),
            ),
        )
        assertEquals(
            "shell_execute  android-notification list",
            toolHintFromMessages(messages),
        )
    }
}
