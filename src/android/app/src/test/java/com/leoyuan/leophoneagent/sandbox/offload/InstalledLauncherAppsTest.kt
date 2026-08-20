package com.leoyuan.leophoneagent.sandbox.offload

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InstalledLauncherAppsTest {
    @Test
    fun `launcher query is MAIN plus LAUNCHER`() {
        val intent = InstalledLauncherApps.launcherQueryIntent()
        assertEquals(Intent.ACTION_MAIN, intent.action)
        assertTrue(intent.hasCategory(Intent.CATEGORY_LAUNCHER))
    }
}
