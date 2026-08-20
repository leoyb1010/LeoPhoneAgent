package com.leoyuan.leophoneagent.sandbox.offload

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Test

class InstalledLauncherAppsTest {
    @Test
    fun `launcher query is MAIN plus LAUNCHER`() {
        // Intent extras are stubbed on the JVM; assert the contract constants
        // the helper uses instead of constructing a live Intent.
        assertEquals(Intent.ACTION_MAIN, InstalledLauncherApps.LAUNCHER_ACTION)
        assertEquals(Intent.CATEGORY_LAUNCHER, InstalledLauncherApps.LAUNCHER_CATEGORY)
    }
}
