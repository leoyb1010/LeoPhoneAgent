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
    fun `sideload package visibility declares QUERY_ALL and launcher queries`() {
        assertTrue(manifest.contains("android.permission.QUERY_ALL_PACKAGES"))
        assertTrue(manifest.contains("android.intent.action.MAIN"))
        assertTrue(manifest.contains("android.intent.category.LAUNCHER"))
        assertTrue(manifest.contains("sideload personal agent"))
    }
}
