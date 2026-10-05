package com.leoyuan.leophoneagent.relay

import org.junit.Assert.assertEquals
import org.junit.Test

class FleetListMergeTest {
    private val presets = parseFleetPresets("Laptop|example-laptop; Mini · lab |example-mini;bad-entry;|x")

    @Test
    fun presetParserSkipsMalformedEntries() {
        assertEquals(
            listOf(FleetPreset("Laptop", "example-laptop"), FleetPreset("Mini · lab", "example-mini")),
            presets,
        )
        assertEquals(emptyList<FleetPreset>(), parseFleetPresets(""))
    }

    @Test
    fun presetsStayAsShortcutAndLiveAndroidAppearsWithoutRepoEdit() {
        val live = listOf(
            RelayMachine("example-mini", online = true, server = "leocodebox"),
            RelayMachine("LeoFold8", online = true, server = "minis", version = "1.0.0-alpha.6"),
        )
        val rows = FleetListMerge.displayMachines(live, presets)
        assertEquals("Laptop", rows[0].label)
        assertEquals(false, rows[0].online)
        assertEquals("Mini · lab", rows[1].label)
        assertEquals(true, rows[1].online)
        val android = rows.last()
        assertEquals("LeoFold8", android.machine)
        assertEquals("LeoFold8", android.label)
        assertEquals(true, android.online)
        assertEquals(true, android.isAndroidBody)
    }
}
