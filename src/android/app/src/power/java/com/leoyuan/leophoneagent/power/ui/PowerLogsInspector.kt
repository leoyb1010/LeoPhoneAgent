package com.leoyuan.leophoneagent.power.ui

import android.widget.Toast
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.leoyuan.leophoneagent.logging.AppLogger
import com.leoyuan.leophoneagent.power.rules.AppRules
import com.leoyuan.leophoneagent.power.rules.RulesHotUpdate
import com.leoyuan.leophoneagent.sandbox.NativeOffloadServer
import com.leoyuan.leophoneagent.ui.settings.SettingsRow
import com.leoyuan.leophoneagent.ui.settings.SettingsSection
import com.leoyuan.leophoneagent.ui.settings.SettingsSwitchRow
import java.io.File

object PowerLogsInspector {
    private const val PREFS = "power_rules"
    private const val KEY_HOT = "hot_update_enabled"

    @Composable
    fun Section() {
        val context = LocalContext.current
        val prefs = remember { context.getSharedPreferences(PREFS, 0) }
        var hot by remember { mutableStateOf(prefs.getBoolean(KEY_HOT, false)) }
        SettingsSection(
            header = "规则审查",
            footer = "开发者向。只下发声明式规则，永不下发代码。默认关闭热更新。",
        ) {
            SettingsSwitchRow(
                title = "允许规则热更新",
                checked = hot,
                onCheckedChange = {
                    hot = it
                    prefs.edit().putBoolean(KEY_HOT, it).apply()
                },
            )
            SettingsRow(
                title = "导出前台节点树",
                subtitle = "写入日志目录 node-tree-inspect.txt",
                onClick = {
                    val dump = NativeOffloadServer.invoke("android-a11y-cli", listOf("ui", "dump"))
                    val dir = File(context.filesDir, "logs").apply { mkdirs() }
                    val out = File(dir, "node-tree-inspect.txt")
                    out.writeText(dump.output)
                    AppLogger.info("PowerRules", "node tree ${out.length()} bytes exit=${dump.exitCode}")
                    Toast.makeText(context, "已写入 ${out.name}", Toast.LENGTH_SHORT).show()
                },
            )
            SettingsRow(
                title = "恢复内置 5 条规则",
                showDivider = false,
                onClick = {
                    val root = File(context.filesDir, "power-rules")
                    val result = RulesHotUpdate.apply(
                        root = root,
                        payload = AppRules.BUNDLED_JSON.trim().toByteArray(),
                        manifest = RulesHotUpdate.bundledManifest(),
                        currentAppVersion = com.leoyuan.leophoneagent.BuildConfig.VERSION_NAME,
                        disabled = false,
                    )
                    AppLogger.info("PowerRules", "reseed $result")
                    Toast.makeText(context, result.toString(), Toast.LENGTH_SHORT).show()
                },
            )
        }
    }
}
