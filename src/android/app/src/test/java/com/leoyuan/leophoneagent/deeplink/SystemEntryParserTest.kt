package com.leoyuan.leophoneagent.deeplink

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SystemEntryParserTest {
    @Test
    fun `assist action becomes Assist even without extras`() {
        val entry = SystemEntryParser.resolve(SystemEntryParser.ACTION_ASSIST, null)
        assertTrue(entry is SystemEntry.Assist)
        val assist = entry as SystemEntry.Assist
        assertNull(assist.sourcePackage)
        assertNull(assist.screenshotPath)
    }

    @Test
    fun `voice command is assist`() {
        val entry = SystemEntryParser.resolve(SystemEntryParser.ACTION_VOICE_COMMAND, null)
        assertTrue(entry is SystemEntry.Assist)
    }

    @Test
    fun `new chat and voice uris`() {
        assertEquals(SystemEntry.NewChat, SystemEntryParser.parseData(SystemEntryParser.NEW_CHAT_URI))
        assertEquals(SystemEntry.VoiceChat, SystemEntryParser.parseData(SystemEntryParser.VOICE_CHAT_URI))
        assertEquals(SystemEntry.LastSession, SystemEntryParser.parseData(SystemEntryParser.LAST_SESSION_URI))
        assertEquals(SystemEntry.CameraChat, SystemEntryParser.parseData("minis://action/camera_chat"))
    }

    @Test
    fun `leophoneagent scheme is accepted`() {
        assertEquals(
            SystemEntry.NewChat,
            SystemEntryParser.parseData("leophoneagent://action/new_chat"),
        )
    }

    @Test
    fun `open session and resume`() {
        assertEquals(
            SystemEntry.OpenSession("abc-123"),
            SystemEntryParser.parseData("minis://session/abc-123"),
        )
        assertEquals(
            SystemEntry.ResumeSession("abc-123"),
            SystemEntryParser.parseData("minis://action/resume?session=abc-123"),
        )
        assertEquals(
            SystemEntry.PauseSession("abc-123"),
            SystemEntryParser.parseData("minis://action/pause?session=abc-123"),
        )
    }

    @Test
    fun `unknown data degrades to Home`() {
        assertEquals(SystemEntry.Home, SystemEntryParser.parseData(null))
        assertEquals(SystemEntry.Home, SystemEntryParser.parseData("https://example.com"))
        assertEquals(SystemEntry.Home, SystemEntryParser.parseData("minis://unknown/path"))
        assertEquals(SystemEntry.Home, SystemEntryParser.parseData("not-a-uri"))
    }

    @Test
    fun `boot and timezone reconcile`() {
        assertEquals(
            SystemEntry.Reconcile,
            SystemEntryParser.resolve(SystemEntryParser.ACTION_BOOT_COMPLETED, null),
        )
        assertEquals(
            SystemEntry.Reconcile,
            SystemEntryParser.resolve(SystemEntryParser.ACTION_TIMEZONE_CHANGED, null),
        )
        assertEquals(
            SystemEntry.Reconcile,
            SystemEntryParser.resolve(SystemEntryParser.ACTION_TIME_CHANGED, null),
        )
    }

    @Test
    fun `notification extras open and pause`() {
        val open = SystemEntryParser.resolve(
            SystemEntryParser.ACTION_OPEN,
            null,
            mapOf(SystemEntryParser.EXTRA_SESSION_ID to "s1"),
        )
        assertEquals(SystemEntry.OpenSession("s1"), open)
        val pause = SystemEntryParser.resolve(
            SystemEntryParser.ACTION_PAUSE,
            null,
            mapOf(SystemEntryParser.EXTRA_SESSION_ID to "s1"),
        )
        assertEquals(SystemEntry.PauseSession("s1"), pause)
    }

    @Test
    fun `assist extras prefer custom package`() {
        val entry = SystemEntryParser.resolve(
            SystemEntryParser.ACTION_ASSIST,
            SystemEntryParser.NEW_CHAT_URI,
            mapOf(
                SystemEntryParser.EXTRA_ASSIST_PACKAGE to "com.other",
                SystemEntryParser.EXTRA_SOURCE_PACKAGE to "com.chrome",
                SystemEntryParser.EXTRA_SCREENSHOT_PATH to "/cache/a.png",
            ),
        )
        val assist = entry as SystemEntry.Assist
        assertEquals("com.chrome", assist.sourcePackage)
        assertEquals("/cache/a.png", assist.screenshotPath)
    }

    @Test
    fun `blank extras are missing`() {
        val entry = SystemEntryParser.resolve(
            SystemEntryParser.ACTION_ASSIST,
            null,
            mapOf(
                SystemEntryParser.EXTRA_SOURCE_PACKAGE to "  ",
                SystemEntryParser.EXTRA_SCREENSHOT_PATH to "",
            ),
        ) as SystemEntry.Assist
        assertNull(entry.sourcePackage)
        assertNull(entry.screenshotPath)
    }

    @Test
    fun `toDeepLinkAction maps product entries`() {
        assertEquals(DeepLinkAction.NewChat, SystemEntryParser.toDeepLinkAction(SystemEntry.NewChat))
        assertEquals(DeepLinkAction.NewVoiceChat, SystemEntryParser.toDeepLinkAction(SystemEntry.VoiceChat))
        assertEquals(DeepLinkAction.LastSession, SystemEntryParser.toDeepLinkAction(SystemEntry.LastSession))
        assertEquals(
            DeepLinkAction.OpenSession("x"),
            SystemEntryParser.toDeepLinkAction(SystemEntry.OpenSession("x")),
        )
        assertEquals(DeepLinkAction.Unknown, SystemEntryParser.toDeepLinkAction(SystemEntry.Home))
    }
}
