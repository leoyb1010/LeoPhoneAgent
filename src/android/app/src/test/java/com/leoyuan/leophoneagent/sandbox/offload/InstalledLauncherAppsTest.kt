package com.leoyuan.leophoneagent.sandbox.offload

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InstalledLauncherAppsTest {
    @Test
    fun `launcher query is MAIN plus LAUNCHER`() {
        // Intent extras are stubbed on the JVM; assert the contract constants
        // the helper uses instead of constructing a live Intent.
        assertEquals(Intent.ACTION_MAIN, InstalledLauncherApps.LAUNCHER_ACTION)
        assertEquals(Intent.CATEGORY_LAUNCHER, InstalledLauncherApps.LAUNCHER_CATEGORY)
    }

    @Test
    fun `resolve prefers exact package then case-insensitive label`() {
        val apps = listOf(
            InstalledLauncherApps.LauncherApp("com.android.settings", "Settings", true),
            InstalledLauncherApps.LauncherApp("com.tencent.mm", "WeChat", true),
        )
        assertEquals(
            "com.android.settings",
            InstalledLauncherApps.resolveFromCatalog(apps, "com.android.settings")?.packageName,
        )
        assertEquals(
            "com.tencent.mm",
            InstalledLauncherApps.resolveFromCatalog(apps, "wechat")?.packageName,
        )
        assertEquals(null, InstalledLauncherApps.resolveFromCatalog(apps, "Chrome"))
        assertEquals(null, InstalledLauncherApps.resolveFromCatalog(apps, "  "))
    }

    @Test
    fun `launchable follows launch intent not exported flag`() {
        assertTrue(InstalledLauncherApps.launchableOf(hasLaunchIntent = true))
        assertFalse(InstalledLauncherApps.launchableOf(hasLaunchIntent = false))
    }
}
