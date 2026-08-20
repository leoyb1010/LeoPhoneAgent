package com.leoyuan.leophoneagent.ui.chat

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.leoyuan.leophoneagent.BuildConfig
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.accessibility.MinisAccessibilityService
import com.leoyuan.leophoneagent.offload.MinisNotificationListenerService
import com.leoyuan.leophoneagent.offload.ShizukuManager

/**
 * In-chat banner when a run is blocked or likely to fail for a missing OS grant.
 */
enum class MissingOsGrant {
    OVERLAY,
    LISTENER,
    ALL_FILES,
    A11Y,
    SHIZUKU,
    MIC,
}

fun toolHintFromMessages(messages: List<ChatMessage>): String? {
    val block = messages.asReversed()
        .firstOrNull { it.role == "assistant" && it.toolBlocks.isNotEmpty() }
        ?: return null
    return block.toolBlocks.joinToString(" ") { "${it.toolName} ${it.toolTitle} ${it.content}" }
}

fun detectMissingOsGrant(
    runActive: Boolean,
    toolHint: String?,
    overlayGranted: Boolean,
    listenerGranted: Boolean,
    allFilesGranted: Boolean,
    a11yGranted: Boolean,
    shizukuReady: Boolean,
    micGranted: Boolean,
    powerEdition: Boolean,
): MissingOsGrant? {
    if (!runActive && toolHint.isNullOrBlank()) return null
    val hint = toolHint.orEmpty().lowercase()
    return when {
        (hint.contains("notif") || hint.contains("android-notification")) &&
            !listenerGranted -> MissingOsGrant.LISTENER
        (hint.contains("a11y") || hint.contains("accessib")) && !a11yGranted -> MissingOsGrant.A11Y
        (hint.contains("speech") || hint.contains("mic") || hint.contains("record")) &&
            !micGranted -> MissingOsGrant.MIC
        hint.contains("overlay") && !overlayGranted -> MissingOsGrant.OVERLAY
        (hint.contains("photo") || hint.contains("storage") || hint.contains("file") ||
            hint.contains("all-files")) && !allFilesGranted -> MissingOsGrant.ALL_FILES
        hint.contains("shizuku") && powerEdition && !shizukuReady -> MissingOsGrant.SHIZUKU
        else -> null
    }
}

@Composable
fun MissingOsGrantBanner(
    sessionId: String,
    runActive: Boolean,
    messages: List<ChatMessage>,
    onOpenSystemPermissions: () -> Unit,
) {
    val context = LocalContext.current
    var dismissed by remember(sessionId) { mutableStateOf<MissingOsGrant?>(null) }
    val toolHint = remember(messages) { toolHintFromMessages(messages) }
    val overlayGranted = Settings.canDrawOverlays(context)
    val listenerGranted = MinisNotificationListenerService.isEnabled(context)
    val allFilesGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.R ||
        Environment.isExternalStorageManager()
    val a11yGranted = MinisAccessibilityService.getInstance() != null
    val shizukuReady = ShizukuManager.isReady()
    val micGranted = ContextCompat.checkSelfPermission(
        context,
        Manifest.permission.RECORD_AUDIO,
    ) == PackageManager.PERMISSION_GRANTED
    val grant = detectMissingOsGrant(
        runActive = runActive,
        toolHint = toolHint,
        overlayGranted = overlayGranted,
        listenerGranted = listenerGranted,
        allFilesGranted = allFilesGranted,
        a11yGranted = a11yGranted,
        shizukuReady = shizukuReady,
        micGranted = micGranted,
        powerEdition = BuildConfig.POWER_FEATURES_ENABLED,
    )
    if (grant == null || grant == dismissed) return
    val message = stringResource(
        when (grant) {
            MissingOsGrant.OVERLAY -> R.string.chat_missing_grant_overlay
            MissingOsGrant.LISTENER -> R.string.chat_missing_grant_listener
            MissingOsGrant.ALL_FILES -> R.string.chat_missing_grant_all_files
            MissingOsGrant.A11Y -> R.string.chat_missing_grant_a11y
            MissingOsGrant.SHIZUKU -> R.string.chat_missing_grant_shizuku
            MissingOsGrant.MIC -> R.string.chat_missing_grant_mic
        },
    )
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpenSystemPermissions),
    ) {
        Row(
            modifier = Modifier.padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.weight(1f),
            )
            IconButton(onClick = { dismissed = grant }) {
                Icon(
                    Icons.Default.Close,
                    contentDescription = stringResource(R.string.chat_missing_grant_dismiss),
                )
            }
        }
    }
}
