package com.leoyuan.leophoneagent.ui.navigation

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class MainActivityManifestPolicyTest {
    private val manifest: String by lazy {
        val candidates = listOf(
            File("src/main/AndroidManifest.xml"),
            File("app/src/main/AndroidManifest.xml"),
            File("src/android/app/src/main/AndroidManifest.xml"),
        )
        val file = candidates.first { it.isFile }
        file.readText()
    }

    private fun flavorManifest(flavor: String): String {
        val candidates = listOf(
            File("src/$flavor/AndroidManifest.xml"),
            File("app/src/$flavor/AndroidManifest.xml"),
            File("src/android/app/src/$flavor/AndroidManifest.xml"),
        )
        return candidates.first { it.isFile }.readText()
    }

    @Test
    fun `MainActivity handles fold and rotation without recreation`() {
        val required = listOf(
            "orientation",
            "screenSize",
            "smallestScreenSize",
            "screenLayout",
            "keyboard",
            "keyboardHidden",
            "uiMode",
        )
        assertTrue(manifest.contains("android:name=\".MainActivity\""))
        required.forEach { flag ->
            assertTrue("MainActivity configChanges missing $flag", manifest.contains(flag))
        }
        assertTrue(manifest.contains("android:windowSoftInputMode=\"adjustResize\""))
    }

    @Test
    fun `common manifest keeps launcher visibility without Power privileges`() {
        assertTrue(!manifest.contains("android.permission.QUERY_ALL_PACKAGES"))
        assertTrue(manifest.contains("android.intent.action.MAIN"))
        assertTrue(manifest.contains("android.intent.category.LAUNCHER"))
    }

    @Test
    fun `text selection menu entry routes PROCESS_TEXT into the share receiver`() {
        val at = manifest.indexOf("android:name=\".share.ProcessTextAlias\"")
        assertTrue("ProcessTextAlias missing", at >= 0)
        val alias = manifest.substring(
            manifest.lastIndexOf("<activity-alias", at),
            manifest.indexOf("</activity-alias>", at),
        )
        assertTrue(alias.contains("android:targetActivity=\".share.ShareReceiverActivity\""))
        assertTrue(alias.contains("android:exported=\"true\""))
        assertTrue(alias.contains("android:label=\"@string/process_text_label\""))
        assertTrue(alias.contains("android:name=\"android.intent.action.PROCESS_TEXT\""))
        assertTrue(alias.contains("android:mimeType=\"text/plain\""))
    }

    @Test
    fun `Power manifest alone declares privileged package visibility`() {
        val power = flavorManifest("power")
        val standard = flavorManifest("standard")
        assertTrue(power.contains("android.permission.QUERY_ALL_PACKAGES"))
        assertTrue(power.contains("android.permission.MANAGE_EXTERNAL_STORAGE"))
        assertTrue(power.contains("moe.shizuku.privileged.api"))
        assertTrue(power.contains(".accessibility.MinisAccessibilityService"))
        assertTrue(standard.contains("moe.shizuku.manager.permission.API_V23"))
        assertTrue(standard.contains("tools:node=\"remove\""))
    }
}
