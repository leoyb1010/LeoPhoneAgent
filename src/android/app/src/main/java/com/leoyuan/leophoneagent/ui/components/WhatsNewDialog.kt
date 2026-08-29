package com.leoyuan.leophoneagent.ui.components

import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import com.leoyuan.leophoneagent.BuildConfig
import com.leoyuan.leophoneagent.R

/**
 * [T-whats-new-gate] 发版铁律第一条(全端通用):每次发版装机后必须弹出
 * 「本次更新」,内容就是这一版真正改了什么。iOS 走 LeoReleaseCatalog、
 * Mac 走 LEO_RELEASE_NOTES;Android 此前没有这个机制,从 alpha.10 起补上。
 *
 * 文案放在 `whats_new_current` 字符串资源里 —— 发版时必须同步更新,
 * 中文资源门禁(verifyChineseResources)会强制它有中文翻译。
 */
object WhatsNewGate {
    private const val PREFS = "whats_new"
    private const val KEY_LAST_SEEN = "last_seen_version_code"

    fun shouldShow(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val lastSeen = prefs.getLong(KEY_LAST_SEEN, -1L)
        if (lastSeen != -1L) return lastSeen < BuildConfig.VERSION_CODE
        // 没有记录时要区分两种情况:全新安装不弹(首启有 onboarding);
        // 从没有本机制的旧版(≤ alpha.9)覆盖升级上来的**必须弹** —— 这正是
        // 发版铁律要覆盖的人群。PackageManager 的安装时间戳能区分两者:
        // 升级过的安装 lastUpdateTime 晚于 firstInstallTime。
        val upgraded = runCatching {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            info.lastUpdateTime > info.firstInstallTime
        }.getOrDefault(false)
        if (!upgraded) markSeen(context)
        return upgraded
    }

    fun markSeen(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putLong(KEY_LAST_SEEN, BuildConfig.VERSION_CODE.toLong())
            .apply()
    }
}

@Composable
fun WhatsNewDialogHost() {
    val context = LocalContext.current
    var visible by remember { mutableStateOf(WhatsNewGate.shouldShow(context)) }
    if (!visible) return

    AlertDialog(
        onDismissRequest = {
            WhatsNewGate.markSeen(context)
            visible = false
        },
        title = {
            Column {
                Text(
                    stringResource(R.string.whats_new_heading),
                    style = MaterialTheme.typography.titleLarge,
                )
                Text(
                    "${BuildConfig.VERSION_NAME.removeSuffix("-power")} · " +
                        stringResource(if (BuildConfig.POWER_FEATURES_ENABLED) R.string.whats_new_power else R.string.whats_new_standard),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        },
        text = {
            val scrollState = rememberScrollState()
            Column(
                Modifier
                    .heightIn(max = 360.dp)
                    .verticalScroll(scrollState),
            ) {
                Text(
                    stringResource(R.string.whats_new_current),
                    style = MaterialTheme.typography.bodySmall,
                )
                if (scrollState.canScrollForward) {
                    Text(
                        stringResource(R.string.whats_new_scroll_hint),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                WhatsNewGate.markSeen(context)
                visible = false
            }) { Text(stringResource(R.string.whats_new_confirm)) }
        },
    )
}
