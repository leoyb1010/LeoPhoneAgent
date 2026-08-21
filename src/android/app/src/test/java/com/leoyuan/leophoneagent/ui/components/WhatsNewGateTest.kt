package com.leoyuan.leophoneagent.ui.components

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WhatsNewGate 的升级判定依赖 Context/PackageManager,由 Fold8 实机验收覆盖
 * (alpha.9 → alpha.10 覆盖安装后必须弹出「本次更新」)。这里锁静态契约:
 * 发版铁律要求弹窗内容"就是这一版真正改了什么" —— 三个门禁 locale 的
 * 文案资源必须存在且非空。
 */
class WhatsNewGateTest {
    @Test
    fun releaseNotesResourceIsDeclaredForAllGateLocales() {
        listOf("values", "values-zh", "values-zh-rTW").forEach { locale ->
            val file = java.io.File("src/main/res/$locale/strings.xml")
            assertTrue("missing strings.xml for $locale", file.exists())
            val text = file.readText()
            assertTrue("whats_new_current missing in $locale", text.contains("name=\"whats_new_current\">•"))
            assertTrue("whats_new_title missing in $locale", text.contains("whats_new_title"))
        }
    }
}
