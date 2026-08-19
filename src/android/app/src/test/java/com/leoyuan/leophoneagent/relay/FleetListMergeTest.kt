package com.leoyuan.leophoneagent.relay

import org.junit.Assert.assertEquals
import org.junit.Test

class FleetListMergeTest {
    @Test
    fun presetsStayAsShortcutAndLiveAndroidAppearsWithoutRepoEdit() {
        val live = listOf(
            RelayMachine("LeodeMac-mini-2", online = true, server = "leocodebox"),
            RelayMachine("LeoFold8", online = true, server = "minis", version = "1.0.0-alpha.6"),
        )
        val rows = FleetListMerge.displayMachines(live, LeoFleetPresets)
        assertEquals("MacBook Pro", rows[0].label)
        assertEquals(false, rows[0].online)
        assertEquals("Mac mini · cortex", rows[1].label)
        assertEquals(true, rows[1].online)
        val android = rows.last()
        assertEquals("LeoFold8", android.machine)
        assertEquals("LeoFold8", android.label)
        assertEquals(true, android.online)
        assertEquals(true, android.isAndroidBody)
    }
}
