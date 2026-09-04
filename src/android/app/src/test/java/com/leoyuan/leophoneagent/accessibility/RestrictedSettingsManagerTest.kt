package com.leoyuan.leophoneagent.accessibility

import android.content.pm.PackageInstaller
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RestrictedSettingsManagerTest {
    @Test fun `only local and downloaded sources are restricted`() {
        assertTrue(RestrictedSettingsManager.isRestrictedSource(PackageInstaller.PACKAGE_SOURCE_LOCAL_FILE))
        assertTrue(RestrictedSettingsManager.isRestrictedSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE))
        assertFalse(RestrictedSettingsManager.isRestrictedSource(PackageInstaller.PACKAGE_SOURCE_UNSPECIFIED))
        assertFalse(RestrictedSettingsManager.isRestrictedSource(PackageInstaller.PACKAGE_SOURCE_STORE))
        assertFalse(RestrictedSettingsManager.isRestrictedSource(PackageInstaller.PACKAGE_SOURCE_OTHER))
    }
}
