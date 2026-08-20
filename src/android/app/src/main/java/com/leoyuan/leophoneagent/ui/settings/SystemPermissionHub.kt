package com.leoyuan.leophoneagent.ui.settings

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.leoyuan.leophoneagent.offload.MinisNotificationListenerService
import com.leoyuan.leophoneagent.power.PowerOptimizationManager

/**
 * Testable status + deep-link helpers for [SystemPermissionsScreen].
 *
 * Each link reuses an already-declared / already-implemented OS grant
 * (overlay, notification listener, all-files, exact alarm, plus the
 * runtime grants the agent already uses). The hub does not invent SMS,
 * call-log, or Bluetooth surfaces.
 */
object SystemPermissionHub {

    data class SettingsDeepLink(
        val action: String,
        val dataUri: String? = null,
    )

    fun overlayGranted(sdk: Int, canDrawOverlays: Boolean): Boolean =
        sdk < Build.VERSION_CODES.M || canDrawOverlays

    fun allFilesGranted(sdk: Int, isExternalStorageManager: Boolean): Boolean =
        sdk < Build.VERSION_CODES.R || isExternalStorageManager

    fun exactAlarmGranted(sdk: Int, canScheduleExactAlarms: Boolean): Boolean =
        sdk < Build.VERSION_CODES.S || canScheduleExactAlarms

    fun exactAlarmNeedsRuntimeGrant(sdk: Int): Boolean =
        sdk >= Build.VERSION_CODES.S

    enum class RuntimeGrant { CONTACTS, CALENDAR, LOCATION, MICROPHONE, CAMERA, PHOTOS }

    fun runtimePermissions(grant: RuntimeGrant, sdk: Int): List<String> = when (grant) {
        RuntimeGrant.CONTACTS -> listOf(android.Manifest.permission.READ_CONTACTS)
        RuntimeGrant.CALENDAR -> listOf(android.Manifest.permission.READ_CALENDAR)
        RuntimeGrant.LOCATION -> listOf(
            android.Manifest.permission.ACCESS_FINE_LOCATION,
            android.Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        RuntimeGrant.MICROPHONE -> listOf(android.Manifest.permission.RECORD_AUDIO)
        RuntimeGrant.CAMERA -> listOf(android.Manifest.permission.CAMERA)
        RuntimeGrant.PHOTOS -> if (sdk >= 33) {
            listOf(android.Manifest.permission.READ_MEDIA_IMAGES)
        } else {
            listOf(android.Manifest.permission.READ_EXTERNAL_STORAGE)
        }
    }

    fun anyPermissionGranted(granted: Map<String, Boolean>, names: List<String>): Boolean =
        names.any { granted[it] == true }

    fun setupMissingCount(
        assistantHeld: Boolean,
        notificationsOn: Boolean,
        batteryExempt: Boolean,
        overlayGranted: Boolean,
        listenerGranted: Boolean,
        allFilesGranted: Boolean,
    ): Int = listOf(
        assistantHeld,
        notificationsOn,
        batteryExempt,
        overlayGranted,
        listenerGranted,
        allFilesGranted,
    ).count { !it }

    fun listenerDegraded(settingsEnabled: Boolean, connected: Boolean): Boolean =
        settingsEnabled && !connected

    fun coverScreenLink(packageName: String): SettingsDeepLink = appDetailsLink(packageName)

    fun overlayLink(packageName: String): SettingsDeepLink = SettingsDeepLink(
        action = Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
        dataUri = "package:$packageName",
    )

    fun notificationListenerLink(): SettingsDeepLink = SettingsDeepLink(
        action = MinisNotificationListenerService.SETTINGS_ACTION,
    )

    fun allFilesLink(packageName: String): SettingsDeepLink = SettingsDeepLink(
        action = Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
        dataUri = "package:$packageName",
    )

    fun exactAlarmLink(packageName: String): SettingsDeepLink = SettingsDeepLink(
        action = Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
        dataUri = "package:$packageName",
    )

    fun appDetailsLink(packageName: String): SettingsDeepLink = SettingsDeepLink(
        action = Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        dataUri = "package:$packageName",
    )

    /**
     * Samsung Device care / sleeping-apps + cover-screen guidance is always
     * shown on One UI. Those restrictions do not surface through the
     * accessibility-degraded path, and we cannot query sleeping-apps state.
     */
    fun shouldShowSamsungKeepAlive(
        vendor: PowerOptimizationManager.Vendor,
    ): Boolean = vendor == PowerOptimizationManager.Vendor.SAMSUNG

    /**
     * Xiaomi / Huawei / OPPO / Vivo keep-alive rows stay behind the existing
     * "service enabled in Settings but process dead" gate. Samsung has its
     * own always-on section so it is excluded here to avoid a duplicate card.
     */
    fun shouldShowDegradedOemGuidance(
        vendor: PowerOptimizationManager.Vendor,
        a11yDegraded: Boolean,
    ): Boolean = a11yDegraded &&
        vendor != PowerOptimizationManager.Vendor.OTHER &&
        vendor != PowerOptimizationManager.Vendor.SAMSUNG

    fun toIntent(link: SettingsDeepLink): Intent =
        Intent(link.action).apply {
            if (link.dataUri != null) data = Uri.parse(link.dataUri)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }

    fun openLink(context: android.content.Context, link: SettingsDeepLink): Boolean {
        val launched = runCatching {
            context.startActivity(toIntent(link))
        }.isSuccess
        if (launched) return true
        val fallback = appDetailsLink(context.packageName)
        return runCatching {
            context.startActivity(toIntent(fallback))
        }.isSuccess
    }

    fun openSamsungDeviceCare(activity: Activity): Boolean {
        if (PowerOptimizationManager.openOemAutostartSettings(activity)) return true
        return PowerOptimizationManager.openAppDetailsSettings(activity)
    }
}
