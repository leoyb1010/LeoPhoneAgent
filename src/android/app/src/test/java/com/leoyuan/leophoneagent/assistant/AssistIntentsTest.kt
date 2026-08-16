package com.leoyuan.leophoneagent.assistant

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AssistIntentsTest {
    @Test
    fun `assist action without extras still opens a launch`() {
        val launch = AssistIntents.parse(AssistIntents.ACTION_ASSIST, emptyMap())
        assertNotNull(launch)
        assertNull(launch?.sourcePackage)
        assertNull(launch?.screenshotPath)
    }

    @Test
    fun `voice command is treated as assist`() {
        assertTrue(AssistIntents.isAssistAction(AssistIntents.ACTION_VOICE_COMMAND))
        assertFalse(AssistIntents.isAssistAction(IntentActionView))
        assertNotNull(AssistIntents.parse(AssistIntents.ACTION_VOICE_COMMAND, emptyMap()))
    }

    @Test
    fun `custom extras win over system assist package`() {
        val launch = AssistIntents.parse(
            AssistIntents.ACTION_ASSIST,
            mapOf(
                AssistIntents.EXTRA_ASSIST_PACKAGE to "com.other.app",
                AssistIntents.EXTRA_SOURCE_PACKAGE to "com.chrome",
                AssistIntents.EXTRA_SCREENSHOT_PATH to "/cache/assist.png",
            ),
        )
        assertEquals("com.chrome", launch?.sourcePackage)
        assertEquals("/cache/assist.png", launch?.screenshotPath)
    }

    @Test
    fun `blank extras are treated as missing`() {
        val launch = AssistIntents.parse(
            AssistIntents.ACTION_ASSIST,
            mapOf(
                AssistIntents.EXTRA_SOURCE_PACKAGE to "  ",
                AssistIntents.EXTRA_SCREENSHOT_PATH to "",
            ),
        )
        assertNotNull(launch)
        assertNull(launch?.sourcePackage)
        assertNull(launch?.screenshotPath)
    }

    @Test
    fun `ordinary view intent is ignored`() {
        assertNull(AssistIntents.parse("android.intent.action.VIEW", emptyMap()))
    }

    @Test
    fun `tile and widget reuse the existing shortcut deep links`() {
        assertTrue(AssistIntents.NEW_CHAT_URI.endsWith("/new_chat"))
        assertTrue(AssistIntents.VOICE_CHAT_URI.endsWith("/voice_chat"))
        assertTrue(AssistIntents.NEW_CHAT_URI.startsWith("minis://action/"))
    }

    companion object {
        private const val IntentActionView = "android.intent.action.VIEW"
    }
}
