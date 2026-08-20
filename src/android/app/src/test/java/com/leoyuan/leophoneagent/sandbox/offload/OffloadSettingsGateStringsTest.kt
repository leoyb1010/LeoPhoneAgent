package com.leoyuan.leophoneagent.sandbox.offload

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class OffloadSettingsGateStringsTest {
    @Test
    fun `new mid-task permission dialogs have zh and default entries`() {
        val names = listOf(
            "offload_gate_open_settings",
            "offload_gate_contacts_title",
            "offload_gate_contacts_message",
            "offload_gate_contacts_message_write",
            "offload_gate_calendar_title",
            "offload_gate_calendar_message_read",
            "offload_gate_calendar_message_write",
            "offload_gate_location_title",
            "offload_gate_location_message",
            "offload_gate_mic_title",
            "offload_gate_mic_message",
            "chat_missing_grant_overlay",
            "system_permissions_listener_degraded",
            "system_permissions_samsung_cover_sub",
        )
        val defaultXml = readStrings("src/main/res/values/strings.xml")
        val zhXml = readStrings("src/main/res/values-zh/strings.xml")
        names.forEach { name ->
            assertTrue("missing default $name", defaultXml.contains("name=\"$name\""))
            assertTrue("missing zh $name", zhXml.contains("name=\"$name\""))
        }
        assertTrue(zhXml.contains("需要通讯录权限"))
        assertTrue(zhXml.contains("需要日历权限"))
        assertTrue(zhXml.contains("需要位置权限"))
        assertTrue(zhXml.contains("封面屏幕应用"))
        assertTrue(!defaultXml.contains("Contacts permission needed</string>") ||
            defaultXml.contains("offload_gate_contacts_title"))
    }

    private fun readStrings(relative: String): String {
        val candidates = listOf(
            File("app/$relative"),
            File("src/android/app/$relative"),
            File(relative),
        )
        return candidates.first { it.exists() }.readText()
    }
}
