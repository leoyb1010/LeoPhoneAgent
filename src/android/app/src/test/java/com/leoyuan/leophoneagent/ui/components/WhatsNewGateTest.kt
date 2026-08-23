package com.leoyuan.leophoneagent.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WhatsNewGate 的升级判定依赖 Context/PackageManager,由 Fold8 实机验收覆盖
 * (上一可用版 → 当前版覆盖安装后必须弹出「本次更新」)。这里锁静态契约。
 *
 * 发版铁律要求弹窗内容"就是这一版真正改了什么"。原来这里只断言文案资源存在
 * 且以 • 开头 —— 那样上一版的文案原封不动留着照样是绿的,"漏更新文案"被伪装
 * 成"检查通过"。所以加了 whats_new_version 版本戳:改 versionName 却没重写
 * 文案,这条就会红。
 */
class WhatsNewGateTest {

    private fun res(locale: String): String {
        val file = java.io.File("src/main/res/$locale/strings.xml")
        assertTrue("missing strings.xml for $locale", file.exists())
        return file.readText()
    }

    @Test
    fun releaseNotesResourceIsDeclaredForAllGateLocales() {
        listOf("values", "values-zh", "values-zh-rTW").forEach { locale ->
            val text = res(locale)
            assertTrue("whats_new_current missing in $locale", text.contains("name=\"whats_new_current\">•"))
            assertTrue("whats_new_title missing in $locale", text.contains("whats_new_title"))
        }
    }

    @Test
    fun releaseNotesAreWrittenForTheVersionBeingShipped() {
        val gradle = java.io.File("build.gradle.kts")
        assertTrue("missing app/build.gradle.kts", gradle.exists())
        val versionName = Regex("""versionName\s*=\s*"([^"]+)"""")
            .find(gradle.readText())?.groupValues?.get(1)
        assertTrue("versionName not found in build.gradle.kts", versionName != null)

        val stamped = Regex("""name="whats_new_version"[^>]*>([^<]+)<""")
            .find(res("values"))?.groupValues?.get(1)?.trim()

        assertEquals(
            "「本次更新」文案的版本戳($stamped)对不上要发的版本($versionName)。" +
                "改了 versionName 就必须重写 whats_new_current,并把 whats_new_version 同步过来 —— " +
                "否则装机后弹出的是上一版的更新内容。",
            versionName,
            stamped,
        )
    }
}
