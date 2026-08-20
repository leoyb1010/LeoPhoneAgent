package com.leoyuan.leophoneagent.ui.settings

import android.provider.Settings
import com.leoyuan.leophoneagent.offload.MinisNotificationListenerService
import com.leoyuan.leophoneagent.power.PowerOptimizationManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SystemPermissionHubTest {
    @Test
    fun `overlay status follows canDrawOverlays on API 23+`() {
        assertTrue(SystemPermissionHub.overlayGranted(sdk = 22, canDrawOverlays = false))
        assertFalse(SystemPermissionHub.overlayGranted(sdk = 26, canDrawOverlays = false))
        assertTrue(SystemPermissionHub.overlayGranted(sdk = 35, canDrawOverlays = true))
    }

    @Test
    fun `all-files status follows isExternalStorageManager on API 30+`() {
        assertTrue(SystemPermissionHub.allFilesGranted(sdk = 29, isExternalStorageManager = false))
        assertFalse(SystemPermissionHub.allFilesGranted(sdk = 30, isExternalStorageManager = false))
        assertTrue(SystemPermissionHub.allFilesGranted(sdk = 35, isExternalStorageManager = true))
    }

    @Test
    fun `exact-alarm status follows canScheduleExactAlarms on API 31+`() {
        assertTrue(SystemPermissionHub.exactAlarmGranted(sdk = 30, canScheduleExactAlarms = false))
        assertFalse(SystemPermissionHub.exactAlarmNeedsRuntimeGrant(30))
        assertTrue(SystemPermissionHub.exactAlarmNeedsRuntimeGrant(31))
        assertFalse(SystemPermissionHub.exactAlarmGranted(sdk = 31, canScheduleExactAlarms = false))
        assertTrue(SystemPermissionHub.exactAlarmGranted(sdk = 35, canScheduleExactAlarms = true))
    }

    @Test
    fun `deep links match the existing system settings actions`() {
        val overlay = SystemPermissionHub.overlayLink("com.leoyuan.leophoneagent")
        assertEquals(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, overlay.action)
        assertEquals("package:com.leoyuan.leophoneagent", overlay.dataUri)

        val listener = SystemPermissionHub.notificationListenerLink()
        assertEquals(MinisNotificationListenerService.SETTINGS_ACTION, listener.action)
        assertNull(listener.dataUri)

        val files = SystemPermissionHub.allFilesLink("com.leoyuan.leophoneagent")
        assertEquals(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, files.action)
        assertEquals("package:com.leoyuan.leophoneagent", files.dataUri)

        val alarm = SystemPermissionHub.exactAlarmLink("com.leoyuan.leophoneagent")
        assertEquals(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, alarm.action)
        assertEquals("package:com.leoyuan.leophoneagent", alarm.dataUri)
    }

    @Test
    fun `Samsung keep-alive is always shown and not gated on a11y-degraded`() {
        assertTrue(
            SystemPermissionHub.shouldShowSamsungKeepAlive(PowerOptimizationManager.Vendor.SAMSUNG),
        )
        assertFalse(
            SystemPermissionHub.shouldShowSamsungKeepAlive(PowerOptimizationManager.Vendor.XIAOMI),
        )
        assertFalse(
            SystemPermissionHub.shouldShowDegradedOemGuidance(
                PowerOptimizationManager.Vendor.SAMSUNG,
                a11yDegraded = true,
            ),
        )
        assertFalse(
            SystemPermissionHub.shouldShowDegradedOemGuidance(
                PowerOptimizationManager.Vendor.XIAOMI,
                a11yDegraded = false,
            ),
        )
        assertTrue(
            SystemPermissionHub.shouldShowDegradedOemGuidance(
                PowerOptimizationManager.Vendor.XIAOMI,
                a11yDegraded = true,
            ),
        )
        assertFalse(
            SystemPermissionHub.shouldShowDegradedOemGuidance(
                PowerOptimizationManager.Vendor.OTHER,
                a11yDegraded = true,
            ),
        )
    }

    @Test
    fun `setup checklist counts missing of the six OS grants`() {
        assertEquals(
            0,
            SystemPermissionHub.setupMissingCount(
                assistantHeld = true,
                notificationsOn = true,
                batteryExempt = true,
                overlayGranted = true,
                listenerGranted = true,
                allFilesGranted = true,
            ),
        )
        assertEquals(
            3,
            SystemPermissionHub.setupMissingCount(
                assistantHeld = false,
                notificationsOn = true,
                batteryExempt = false,
                overlayGranted = true,
                listenerGranted = false,
                allFilesGranted = true,
            ),
        )
    }

    @Test
    fun `listener is degraded when Settings says on but service is disconnected`() {
        assertTrue(SystemPermissionHub.listenerDegraded(settingsEnabled = true, connected = false))
        assertFalse(SystemPermissionHub.listenerDegraded(settingsEnabled = true, connected = true))
        assertFalse(SystemPermissionHub.listenerDegraded(settingsEnabled = false, connected = false))
    }

    @Test
    fun `cover screen row opens app details not Device Care`() {
        assertTrue(SystemPermissionHub.coverScreenOpensAppDetails())
    }

    @Test
    fun `runtime grant permission names stay on already-declared surfaces`() {
        assertEquals(
            listOf(android.Manifest.permission.READ_CONTACTS),
            SystemPermissionHub.runtimePermissions(SystemPermissionHub.RuntimeGrant.CONTACTS, 35),
        )
        assertEquals(
            listOf(android.Manifest.permission.READ_CALENDAR),
            SystemPermissionHub.runtimePermissions(SystemPermissionHub.RuntimeGrant.CALENDAR, 35),
        )
        assertTrue(
            SystemPermissionHub.runtimePermissions(SystemPermissionHub.RuntimeGrant.LOCATION, 35)
                .contains(android.Manifest.permission.ACCESS_FINE_LOCATION),
        )
        assertEquals(
            listOf(android.Manifest.permission.RECORD_AUDIO),
            SystemPermissionHub.runtimePermissions(SystemPermissionHub.RuntimeGrant.MICROPHONE, 35),
        )
        assertEquals(
            listOf(android.Manifest.permission.CAMERA),
            SystemPermissionHub.runtimePermissions(SystemPermissionHub.RuntimeGrant.CAMERA, 35),
        )
        assertEquals(
            listOf(android.Manifest.permission.READ_MEDIA_IMAGES),
            SystemPermissionHub.runtimePermissions(SystemPermissionHub.RuntimeGrant.PHOTOS, 33),
        )
        assertEquals(
            listOf(android.Manifest.permission.READ_EXTERNAL_STORAGE),
            SystemPermissionHub.runtimePermissions(SystemPermissionHub.RuntimeGrant.PHOTOS, 28),
        )
        assertTrue(
            SystemPermissionHub.anyPermissionGranted(
                mapOf(android.Manifest.permission.CAMERA to true),
                listOf(android.Manifest.permission.CAMERA),
            ),
        )
        assertFalse(
            SystemPermissionHub.anyPermissionGranted(
                mapOf(android.Manifest.permission.CAMERA to false),
                listOf(android.Manifest.permission.CAMERA),
            ),
        )
    }
}
