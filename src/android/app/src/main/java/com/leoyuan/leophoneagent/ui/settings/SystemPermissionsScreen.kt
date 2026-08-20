package com.leoyuan.leophoneagent.ui.settings

import android.content.pm.PackageManager
import android.widget.Toast
import android.app.Activity
import android.app.StatusBarManager
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.app.AlarmManager
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.DeleteSweep
import androidx.compose.material.icons.outlined.RecordVoiceOver
import androidx.compose.material.icons.outlined.Accessibility
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.BatteryAlert
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Dashboard
import androidx.compose.material.icons.outlined.RestartAlt
import androidx.compose.material.icons.outlined.Widgets
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.Layers
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.Contacts
import androidx.compose.material.icons.outlined.Event
import androidx.compose.material.icons.outlined.LocationOn
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.PhotoCamera
import androidx.compose.material.icons.outlined.PhotoLibrary
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material3.TextButton
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.accessibility.MinisAccessibilityService
import com.leoyuan.leophoneagent.offload.MinisNotificationListenerService
import com.leoyuan.leophoneagent.power.PowerOptimizationManager
import kotlinx.coroutines.delay

/**
 * T323: surfaces OS-level permission states (Accessibility service,
 * etc.) the user must grant via external Settings flows. Each row
 * reports current status and routes the user to the relevant system
 * settings page; we re-poll while the screen is visible so coming
 * back from system Settings refreshes the row automatically.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SystemPermissionsScreen(
    onBack: () -> Unit,
    onOpenOffloadPermissions: () -> Unit = {},
) {
    val context = LocalContext.current
    val roleLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { /* ON_RESUME / poll refreshes isHeld */ }
    var assistantHeld by remember {
        mutableStateOf(com.leoyuan.leophoneagent.assistant.AssistantRole.isHeld(context))
    }
    var a11yEnabled by remember { mutableStateOf(isAccessibilityEnabled(context)) }
    // [T-android-a11y-miui-service-failure] "Service failed" degraded state:
    // the OEM ROM (MIUI etc.) reports the service as enabled in Settings but
    // has killed the process / revoked the binding, so getInstance() is null.
    // On such a device the canonical remediation is autostart-whitelist +
    // battery "no restrictions"; surface those (reusing PowerOptimizationManager)
    // only when the service is degraded AND the vendor is known to enforce it.
    var a11yDegraded by remember { mutableStateOf(false) }
    var notificationsOn by remember { mutableStateOf(areNotificationsEnabled(context)) }
    var batteryExempt by remember {
        mutableStateOf(PowerOptimizationManager.isIgnoringBatteryOptimizations(context))
    }
    var overlayGranted by remember { mutableStateOf(currentOverlayGranted(context)) }
    var listenerGranted by remember { mutableStateOf(MinisNotificationListenerService.isEnabled(context)) }
    var listenerConnected by remember { mutableStateOf(MinisNotificationListenerService.isConnected()) }
    var contactsGranted by remember { mutableStateOf(runtimeGranted(context, SystemPermissionHub.RuntimeGrant.CONTACTS)) }
    var calendarGranted by remember { mutableStateOf(runtimeGranted(context, SystemPermissionHub.RuntimeGrant.CALENDAR)) }
    var locationGranted by remember { mutableStateOf(runtimeGranted(context, SystemPermissionHub.RuntimeGrant.LOCATION)) }
    var micGranted by remember { mutableStateOf(runtimeGranted(context, SystemPermissionHub.RuntimeGrant.MICROPHONE)) }
    var cameraGranted by remember { mutableStateOf(runtimeGranted(context, SystemPermissionHub.RuntimeGrant.CAMERA)) }
    var photosGranted by remember { mutableStateOf(runtimeGranted(context, SystemPermissionHub.RuntimeGrant.PHOTOS)) }
    val runtimeLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { /* poll refreshes rows */ }
    var allFilesGranted by remember { mutableStateOf(currentAllFilesGranted(context)) }
    var exactAlarmGranted by remember { mutableStateOf(currentExactAlarmGranted(context)) }
    var shizukuLabel by remember { mutableStateOf(shizukuStatusLabel(context)) }
    val vendor = remember { PowerOptimizationManager.Vendor.current() }

    LaunchedEffect(Unit) {
        while (true) {
            assistantHeld = com.leoyuan.leophoneagent.assistant.AssistantRole.isHeld(context)
            val inSettings = isAccessibilityEnabled(context)
            val connected = MinisAccessibilityService.getInstance() != null
            a11yEnabled = inSettings || connected
            a11yDegraded = inSettings && !connected
            notificationsOn = areNotificationsEnabled(context)
            batteryExempt = PowerOptimizationManager.isIgnoringBatteryOptimizations(context)
            overlayGranted = currentOverlayGranted(context)
            listenerGranted = MinisNotificationListenerService.isEnabled(context)
            listenerConnected = MinisNotificationListenerService.isConnected()
            contactsGranted = runtimeGranted(context, SystemPermissionHub.RuntimeGrant.CONTACTS)
            calendarGranted = runtimeGranted(context, SystemPermissionHub.RuntimeGrant.CALENDAR)
            locationGranted = runtimeGranted(context, SystemPermissionHub.RuntimeGrant.LOCATION)
            micGranted = runtimeGranted(context, SystemPermissionHub.RuntimeGrant.MICROPHONE)
            cameraGranted = runtimeGranted(context, SystemPermissionHub.RuntimeGrant.CAMERA)
            photosGranted = runtimeGranted(context, SystemPermissionHub.RuntimeGrant.PHOTOS)
            allFilesGranted = currentAllFilesGranted(context)
            exactAlarmGranted = currentExactAlarmGranted(context)
            shizukuLabel = shizukuStatusLabel(context)
            delay(1000)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.system_permissions_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState()),
        ) {
            val setupMissing = SystemPermissionHub.setupMissingCount(
                assistantHeld = assistantHeld,
                notificationsOn = notificationsOn,
                batteryExempt = batteryExempt,
                overlayGranted = overlayGranted,
                listenerGranted = listenerGranted && !SystemPermissionHub.listenerDegraded(
                    listenerGranted,
                    listenerConnected,
                ),
                allFilesGranted = allFilesGranted,
            )
            SettingsSection(
                header = stringResource(R.string.system_permissions_setup_header),
                footer = if (vendor == PowerOptimizationManager.Vendor.SAMSUNG) {
                    stringResource(R.string.system_permissions_setup_samsung_note)
                } else {
                    stringResource(R.string.system_permissions_setup_footer)
                },
            ) {
                SettingsRow(
                    icon = Icons.Outlined.Checklist,
                    iconColor = Color(0xFF007AFF),
                    title = if (setupMissing == 0) {
                        stringResource(R.string.system_permissions_setup_complete)
                    } else {
                        stringResource(R.string.system_permissions_setup_missing, setupMissing)
                    },
                    subtitle = stringResource(R.string.system_permissions_setup_sub),
                    showDivider = false,
                )
            }

            SettingsSection(
                header = stringResource(R.string.system_permissions_cross_header),
            ) {
                SettingsRow(
                    icon = Icons.Outlined.Shield,
                    iconColor = Color(0xFF5856D6),
                    title = stringResource(R.string.system_permissions_open_offload),
                    subtitle = stringResource(R.string.system_permissions_open_offload_sub),
                    onClick = onOpenOffloadPermissions,
                    showDivider = false,
                )
            }

            SettingsSection(
                header = stringResource(R.string.system_permissions_section_assistant),
                footer = stringResource(R.string.system_permissions_assistant_footer),
            ) {
                SettingsRow(
                    icon = Icons.Outlined.AutoAwesome,
                    iconColor = Color(0xFF5856D6),
                    title = stringResource(R.string.system_permissions_assistant_row),
                    subtitle = if (assistantHeld) {
                        stringResource(R.string.system_permissions_assistant_enabled)
                    } else {
                        stringResource(R.string.system_permissions_assistant_disabled)
                    },
                    onClick = {
                        try {
                            roleLauncher.launch(
                                com.leoyuan.leophoneagent.assistant.AssistantRole.requestIntent(context),
                            )
                        } catch (_: Throwable) {
                            try {
                                context.startActivity(
                                    com.leoyuan.leophoneagent.assistant.AssistantRole.fallbackSettingsIntent()
                                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                                )
                            } catch (_: Throwable) {}
                        }
                    },
                )
                SettingsRow(
                    icon = Icons.Outlined.Dashboard,
                    iconColor = Color(0xFF007AFF),
                    title = stringResource(R.string.system_permissions_qs_row),
                    subtitle = stringResource(R.string.system_permissions_qs_sub),
                    onClick = { requestQuickTile(context) },
                )
                SettingsRow(
                    icon = Icons.Outlined.Widgets,
                    iconColor = Color(0xFF34C759),
                    title = stringResource(R.string.system_permissions_widget_row),
                    subtitle = stringResource(R.string.system_permissions_widget_sub),
                    onClick = { requestPinWidget(context) },
                    showDivider = false,
                )
            }

            SettingsSection(
                header = stringResource(R.string.system_entry_hub_header),
                footer = stringResource(R.string.system_entry_hub_footer),
            ) {
                SettingsRow(
                    icon = Icons.Outlined.Notifications,
                    iconColor = Color(0xFFFF9500),
                    title = stringResource(R.string.system_permissions_notifications_row),
                    subtitle = if (notificationsOn) {
                        stringResource(R.string.system_permissions_notifications_on)
                    } else {
                        stringResource(R.string.system_permissions_notifications_off)
                    },
                    onClick = { openNotificationSettings(context) },
                )
                SettingsRow(
                    icon = Icons.Outlined.BatteryAlert,
                    iconColor = Color(0xFFFF9500),
                    title = stringResource(R.string.system_permissions_battery_row),
                    subtitle = if (batteryExempt) {
                        stringResource(R.string.system_permissions_battery_on)
                    } else {
                        stringResource(R.string.system_permissions_battery_off)
                    },
                    onClick = {
                        val activity = context as? Activity
                        if (activity != null) {
                            if (!PowerOptimizationManager.requestBatteryOptimizationExemption(activity)) {
                                PowerOptimizationManager.openAppDetailsSettings(activity)
                            }
                        } else {
                            openAppDetails(context)
                        }
                    },
                )
                SettingsRow(
                    icon = Icons.Outlined.Apps,
                    iconColor = Color(0xFF007AFF),
                    title = stringResource(R.string.system_permissions_shortcuts_row),
                    subtitle = stringResource(R.string.system_permissions_shortcuts_sub),
                    onClick = { openAppDetails(context) },
                )
                SettingsRow(
                    icon = Icons.Outlined.Layers,
                    iconColor = Color(0xFF5856D6),
                    title = stringResource(R.string.system_permissions_overlay_row),
                    subtitle = if (overlayGranted) {
                        stringResource(R.string.system_permissions_overlay_on)
                    } else {
                        stringResource(R.string.system_permissions_overlay_off)
                    },
                    onClick = {
                        SystemPermissionHub.openLink(
                            context,
                            SystemPermissionHub.overlayLink(context.packageName),
                        )
                    },
                )
                SettingsRow(
                    icon = Icons.Outlined.NotificationsActive,
                    iconColor = Color(0xFFFF9500),
                    title = stringResource(R.string.system_permissions_listener_row),
                    subtitle = when {
                        SystemPermissionHub.listenerDegraded(listenerGranted, listenerConnected) ->
                            stringResource(R.string.system_permissions_listener_degraded)
                        listenerGranted ->
                            stringResource(R.string.system_permissions_listener_on)
                        else ->
                            stringResource(R.string.system_permissions_listener_off)
                    },
                    onClick = {
                        SystemPermissionHub.openLink(
                            context,
                            SystemPermissionHub.notificationListenerLink(),
                        )
                    },
                )
                SettingsRow(
                    icon = Icons.Outlined.Folder,
                    iconColor = Color(0xFF007AFF),
                    title = stringResource(R.string.system_permissions_all_files_row),
                    subtitle = if (allFilesGranted) {
                        stringResource(R.string.system_permissions_all_files_on)
                    } else {
                        stringResource(R.string.system_permissions_all_files_off)
                    },
                    onClick = {
                        SystemPermissionHub.openLink(
                            context,
                            SystemPermissionHub.allFilesLink(context.packageName),
                        )
                    },
                )
                SettingsRow(
                    icon = Icons.Outlined.Schedule,
                    iconColor = Color(0xFF34C759),
                    title = stringResource(R.string.system_permissions_exact_alarm_row),
                    subtitle = when {
                        !SystemPermissionHub.exactAlarmNeedsRuntimeGrant(Build.VERSION.SDK_INT) ->
                            stringResource(R.string.system_permissions_exact_alarm_na)
                        exactAlarmGranted ->
                            stringResource(R.string.system_permissions_exact_alarm_on)
                        else ->
                            stringResource(R.string.system_permissions_exact_alarm_off)
                    },
                    onClick = {
                        if (SystemPermissionHub.exactAlarmNeedsRuntimeGrant(Build.VERSION.SDK_INT)) {
                            SystemPermissionHub.openLink(
                                context,
                                SystemPermissionHub.exactAlarmLink(context.packageName),
                            )
                        } else {
                            openAppDetails(context)
                        }
                    },
                    showDivider = !com.leoyuan.leophoneagent.BuildConfig.POWER_FEATURES_ENABLED,
                )
                if (com.leoyuan.leophoneagent.BuildConfig.POWER_FEATURES_ENABLED) {
                    SettingsRow(
                        icon = Icons.Outlined.Shield,
                        iconColor = Color(0xFF5856D6),
                        title = stringResource(R.string.system_permissions_shizuku_row),
                        subtitle = shizukuLabel,
                        onClick = { openShizuku(context) },
                        showDivider = false,
                    )
                }
            }

            SettingsSection(
                header = stringResource(R.string.system_permissions_runtime_header),
                footer = stringResource(R.string.system_permissions_runtime_footer),
            ) {
                RuntimeGrantRow(
                    icon = Icons.Outlined.Contacts,
                    title = stringResource(R.string.system_permissions_runtime_contacts),
                    granted = contactsGranted,
                    onClick = { requestRuntime(context, runtimeLauncher, SystemPermissionHub.RuntimeGrant.CONTACTS) },
                )
                RuntimeGrantRow(
                    icon = Icons.Outlined.Event,
                    title = stringResource(R.string.system_permissions_runtime_calendar),
                    granted = calendarGranted,
                    onClick = { requestRuntime(context, runtimeLauncher, SystemPermissionHub.RuntimeGrant.CALENDAR) },
                )
                RuntimeGrantRow(
                    icon = Icons.Outlined.LocationOn,
                    title = stringResource(R.string.system_permissions_runtime_location),
                    granted = locationGranted,
                    onClick = { requestRuntime(context, runtimeLauncher, SystemPermissionHub.RuntimeGrant.LOCATION) },
                )
                RuntimeGrantRow(
                    icon = Icons.Outlined.Mic,
                    title = stringResource(R.string.system_permissions_runtime_mic),
                    granted = micGranted,
                    onClick = { requestRuntime(context, runtimeLauncher, SystemPermissionHub.RuntimeGrant.MICROPHONE) },
                )
                RuntimeGrantRow(
                    icon = Icons.Outlined.PhotoCamera,
                    title = stringResource(R.string.system_permissions_runtime_camera),
                    granted = cameraGranted,
                    onClick = { requestRuntime(context, runtimeLauncher, SystemPermissionHub.RuntimeGrant.CAMERA) },
                )
                RuntimeGrantRow(
                    icon = Icons.Outlined.PhotoLibrary,
                    title = stringResource(R.string.system_permissions_runtime_photos),
                    granted = photosGranted,
                    onClick = { requestRuntime(context, runtimeLauncher, SystemPermissionHub.RuntimeGrant.PHOTOS) },
                    showDivider = false,
                )
            }

            SettingsSection(
                header = stringResource(R.string.system_permissions_section_a11y),
                footer = stringResource(R.string.system_permissions_a11y_footer),
            ) {
                SettingsRow(
                    icon = Icons.Outlined.Accessibility,
                    iconColor = Color(0xFF34C759),
                    title = stringResource(R.string.system_permissions_a11y_row),
                    subtitle = if (a11yEnabled)
                        stringResource(R.string.system_permissions_a11y_enabled)
                    else
                        stringResource(R.string.system_permissions_a11y_disabled),
                    onClick = { openAccessibilitySettings(context) },
                    showDivider = false,
                )
            }

            // [T-android-a11y-miui-service-failure] OEM keep-alive guidance. Only
            // shown when the service is degraded ("此服务出现故障" — enabled in
            // Settings but the process was killed by the ROM) AND the vendor is
            // one known to enforce autostart on top of stock Android. Routes the
            // two canonical remediations through the existing
            // PowerOptimizationManager (which already catches a missing Activity
            // and falls back). Stays hidden on Pixel / stock Android (Vendor.OTHER).
            // Samsung is excluded here — One UI sleeping-apps / cover-screen
            // guidance is always shown below, not gated on a11y-degraded.
            val activity = context as? Activity
            if (activity != null &&
                SystemPermissionHub.shouldShowDegradedOemGuidance(vendor, a11yDegraded)
            ) {
                SettingsSection(
                    header = stringResource(R.string.system_permissions_a11y_oem_header),
                    footer = stringResource(R.string.system_permissions_a11y_oem_footer, vendor.displayName),
                ) {
                    SettingsRow(
                        icon = Icons.Outlined.RestartAlt,
                        iconColor = Color(0xFFFF9500),
                        title = stringResource(R.string.system_permissions_a11y_oem_autostart),
                        subtitle = stringResource(R.string.system_permissions_a11y_oem_autostart_sub),
                        onClick = {
                            if (!PowerOptimizationManager.openOemAutostartSettings(activity)) {
                                PowerOptimizationManager.openAppDetailsSettings(activity)
                            }
                        },
                    )
                    SettingsRow(
                        icon = Icons.Outlined.BatteryAlert,
                        iconColor = Color(0xFFFF9500),
                        title = stringResource(R.string.system_permissions_a11y_oem_battery),
                        subtitle = stringResource(R.string.system_permissions_a11y_oem_battery_sub),
                        onClick = {
                            if (!PowerOptimizationManager.requestBatteryOptimizationExemption(activity)) {
                                PowerOptimizationManager.openAppDetailsSettings(activity)
                            }
                        },
                        showDivider = false,
                    )
                }
            }

            if (SystemPermissionHub.shouldShowSamsungKeepAlive(vendor)) {
                SettingsSection(
                    header = stringResource(R.string.system_permissions_samsung_header),
                    footer = stringResource(R.string.system_permissions_samsung_footer),
                ) {
                    SettingsRow(
                        icon = Icons.Outlined.PhoneAndroid,
                        iconColor = Color(0xFFFF9500),
                        title = stringResource(R.string.system_permissions_samsung_sleeping_row),
                        subtitle = stringResource(R.string.system_permissions_samsung_sleeping_sub),
                        onClick = {
                            if (activity != null) {
                                SystemPermissionHub.openSamsungDeviceCare(activity)
                            } else {
                                openAppDetails(context)
                            }
                        },
                    )
                    SettingsRow(
                        icon = Icons.Outlined.PhoneAndroid,
                        iconColor = Color(0xFF007AFF),
                        title = stringResource(R.string.system_permissions_samsung_cover_row),
                        subtitle = stringResource(R.string.system_permissions_samsung_cover_sub),
                        onClick = { openAppDetails(context) },
                        showDivider = false,
                    )
                }
            }

            // [T-android-voice-correction] Phase 4: opt-in consent for storing
            // correction learning data, plus the wipe action. Placed here
            // because it is a privacy control, matching iOS's Permissions page.
            var correctionEnabled by remember {
                mutableStateOf(
                    com.leoyuan.leophoneagent.speech.correction.VoiceCorrectionConsent.isEnabled(context),
                )
            }
            var showClearCorrectionConfirm by remember { mutableStateOf(false) }

            SettingsSection(
                header = stringResource(R.string.voice_correction_section),
                footer = stringResource(R.string.voice_correction_footer),
            ) {
                SettingsSwitchRow(
                    icon = Icons.Outlined.RecordVoiceOver,
                    title = stringResource(R.string.voice_correction_toggle),
                    checked = correctionEnabled,
                    onCheckedChange = { on ->
                        correctionEnabled = on
                        com.leoyuan.leophoneagent.speech.correction.VoiceCorrectionConsent
                            .setEnabled(context, on)
                        // Turning the toggle off counts as an answer, so the
                        // one-time prompt must not reappear afterwards.
                        com.leoyuan.leophoneagent.speech.correction.VoiceCorrectionConsent
                            .setPrompted(context, true)
                    },
                )
                SettingsRow(
                    icon = Icons.Outlined.DeleteSweep,
                    iconColor = MaterialTheme.colorScheme.error,
                    title = stringResource(R.string.voice_correction_clear),
                    titleColor = MaterialTheme.colorScheme.error,
                    onClick = { showClearCorrectionConfirm = true },
                    showDivider = false,
                )
            }

            if (showClearCorrectionConfirm) {
                AlertDialog(
                    onDismissRequest = { showClearCorrectionConfirm = false },
                    title = { Text(stringResource(R.string.voice_correction_clear_title)) },
                    confirmButton = {
                        TextButton(onClick = {
                            showClearCorrectionConfirm = false
                            com.leoyuan.leophoneagent.speech.correction.VoiceCorrection
                                .clearAllData(context)
                            Toast.makeText(
                                context,
                                context.getString(R.string.voice_correction_cleared),
                                Toast.LENGTH_SHORT,
                            ).show()
                        }) {
                            Text(
                                stringResource(R.string.voice_correction_clear),
                                color = MaterialTheme.colorScheme.error,
                            )
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { showClearCorrectionConfirm = false }) {
                            Text(stringResource(R.string.voice_correction_consent_not_now))
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun RuntimeGrantRow(
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    title: String,
    granted: Boolean,
    onClick: () -> Unit,
    showDivider: Boolean = true,
) {
    SettingsRow(
        icon = icon,
        iconColor = Color(0xFF007AFF),
        title = title,
        subtitle = if (granted) {
            stringResource(R.string.system_permissions_runtime_on)
        } else {
            stringResource(R.string.system_permissions_runtime_off)
        },
        onClick = onClick,
        showDivider = showDivider,
    )
}

private fun runtimeGranted(context: Context, grant: SystemPermissionHub.RuntimeGrant): Boolean {
    val names = SystemPermissionHub.runtimePermissions(grant, Build.VERSION.SDK_INT)
    return names.any {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }
}

private fun requestRuntime(
    context: Context,
    launcher: androidx.activity.result.ActivityResultLauncher<Array<String>>,
    grant: SystemPermissionHub.RuntimeGrant,
) {
    val names = SystemPermissionHub.runtimePermissions(grant, Build.VERSION.SDK_INT)
    if (names.any { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }) {
        launcher.launch(names.toTypedArray())
    } else {
        openAppDetails(context)
    }
}

private fun currentOverlayGranted(context: Context): Boolean =
    SystemPermissionHub.overlayGranted(Build.VERSION.SDK_INT, Settings.canDrawOverlays(context))

private fun currentAllFilesGranted(context: Context): Boolean {
    val isManager = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
        Environment.isExternalStorageManager()
    return SystemPermissionHub.allFilesGranted(Build.VERSION.SDK_INT, isManager)
}

private fun currentExactAlarmGranted(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    val alarm = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
    val canSchedule = try {
        alarm?.canScheduleExactAlarms() == true
    } catch (_: Throwable) {
        false
    }
    return SystemPermissionHub.exactAlarmGranted(Build.VERSION.SDK_INT, canSchedule)
}

private fun isAccessibilityEnabled(context: Context): Boolean {
    val expected = "${context.packageName}/${MinisAccessibilityService::class.java.name}"
    val enabled = Settings.Secure.getString(
        context.contentResolver,
        Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
    ) ?: return false
    return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
}

private fun requestQuickTile(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        val statusBar = context.getSystemService(StatusBarManager::class.java)
        try {
            statusBar?.requestAddTileService(
                ComponentName(context, com.leoyuan.leophoneagent.tile.LeoQuickTileService::class.java),
                context.getString(R.string.qs_tile_label),
                Icon.createWithResource(context, R.drawable.ic_qs_new_chat),
                context.mainExecutor,
            ) { /* added / already / rejected — user sees the system sheet */ }
            return
        } catch (_: Throwable) {}
    }
    Toast.makeText(context, context.getString(R.string.system_permissions_qs_manual), Toast.LENGTH_SHORT).show()
}

private fun areNotificationsEnabled(context: Context): Boolean =
    androidx.core.app.NotificationManagerCompat.from(context).areNotificationsEnabled()

private fun openNotificationSettings(context: Context) {
    val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
            putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        }
    } else {
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = android.net.Uri.fromParts("package", context.packageName, null)
        }
    }
    runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

private fun openAppDetails(context: Context) {
    runCatching {
        context.startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = android.net.Uri.fromParts("package", context.packageName, null)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            },
        )
    }
}

private fun shizukuStatusLabel(context: Context): String {
    if (!com.leoyuan.leophoneagent.BuildConfig.POWER_FEATURES_ENABLED) {
        return context.getString(R.string.system_permissions_shizuku_standard)
    }
    return when (com.leoyuan.leophoneagent.offload.ShizukuManager.snapshot.value.state) {
        com.leoyuan.leophoneagent.offload.ShizukuManager.State.READY ->
            context.getString(R.string.system_permissions_shizuku_ready)
        com.leoyuan.leophoneagent.offload.ShizukuManager.State.NEED_PERMISSION ->
            context.getString(R.string.system_permissions_shizuku_need_perm)
        com.leoyuan.leophoneagent.offload.ShizukuManager.State.NOT_RUNNING ->
            context.getString(R.string.system_permissions_shizuku_not_running)
        com.leoyuan.leophoneagent.offload.ShizukuManager.State.NOT_INSTALLED ->
            context.getString(R.string.system_permissions_shizuku_not_installed)
    }
}

private fun openShizuku(context: Context) {
    runCatching {
        val mgr = com.leoyuan.leophoneagent.offload.ShizukuManager
        if (mgr.isInstalled()) mgr.openShizukuApp(context) else mgr.openInstallPage(context)
    }
}

private fun requestPinWidget(context: Context) {
    val manager = AppWidgetManager.getInstance(context)
    val component = ComponentName(context, com.leoyuan.leophoneagent.widget.LeoHomeWidgetProvider::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.isRequestPinAppWidgetSupported) {
        try {
            manager.requestPinAppWidget(component, null, null)
            return
        } catch (_: Throwable) {}
    }
    Toast.makeText(context, context.getString(R.string.system_permissions_widget_manual), Toast.LENGTH_SHORT).show()
}

private fun openAccessibilitySettings(context: Context) {
    try {
        context.startActivity(
            Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
        )
    } catch (_: Throwable) {
        try {
            context.startActivity(
                Intent(Settings.ACTION_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            )
        } catch (_: Throwable) {}
    }
}
