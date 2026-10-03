package com.leoyuan.leophoneagent.ui.chat

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.data.model.*
import com.leoyuan.leophoneagent.data.repository.ProviderRepository
import com.leoyuan.leophoneagent.ui.theme.MinisTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Runs the production sheet on an Android emulator with only synthetic configuration. */
@RunWith(AndroidJUnit4::class)
class ModelPickerProductAuditTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val selectedGroup = mutableStateOf<String?>("primary")
    private val selectedEntry = mutableStateOf<String?>("second")
    private val open = mutableStateOf(true)
    private var selectedCallback: String? = null
    private var manageCount = 0

    private fun mount(longNames: Boolean = false) {
        val config = ProviderConfig(
            instances = mutableListOf(ProviderInstance("audit-provider", "Audit Provider", ProviderType.openAI, ProviderCredential.apiKey)),
            modelEntries = mutableListOf(
                ModelEntry("audit-provider", LLMModel("audit-first", "Matching Alpha", "OpenAI"), uuid = "first"),
                ModelEntry("audit-provider", LLMModel("audit-second", "Matching Beta", "OpenAI"), uuid = "second"),
                ModelEntry("audit-provider", LLMModel("audit-hidden", "Hidden Sentinel", "OpenAI"), isHidden = true, uuid = "hidden"),
            ),
        )
        val groups = listOf(
            ModelGroup("primary", if (longNames) "Primary multilingual group 长名称测试 長いモデルグループ" else "Primary audit group", mutableListOf("first", "second")),
            ModelGroup("secondary", "Secondary audit group", mutableListOf("first", "second")),
        )
        val repository = ProviderRepository(context)
        val dark = InstrumentationRegistry.getArguments().getString("auditDark") == "true"
        compose.setContent {
            MinisTheme(darkTheme = dark) {
                if (open.value) {
                    ModelPickerSheet(
                        groups = groups, selectedGroupId = selectedGroup.value,
                        activeEntryId = selectedEntry.value, defaultPrimaryGroupId = "primary",
                        config = config, providerRepository = repository,
                        onSelectGroup = { selectedGroup.value = it },
                        onSelectGroupEntry = { group, entry -> selectedGroup.value = group; selectedEntry.value = entry },
                        onSelectEntry = { selectedCallback = it; selectedGroup.value = null; selectedEntry.value = it },
                        onManageCli = { manageCount++ }, onDismiss = { open.value = false },
                    )
                } else Button(onClick = { open.value = true }) { Text("Reopen audit picker") }
            }
        }
        compose.waitForIdle()
    }

    private fun screenshot(name: String) {
        compose.waitForIdle()
        val profile = InstrumentationRegistry.getArguments().getString("auditProfile") ?: "unspecified"
        // AGP collects this directory before uninstalling the test application.
        val outputBase = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")
            ?.let(::File)
            ?: File(requireNotNull(context.externalMediaDirs.firstOrNull()), "additional_test_output")
        val dir = File(outputBase, profile).apply { check(mkdirs() || isDirectory) }
        val configuration = compose.activity.resources.configuration
        val expectedFontScale = if (profile.endsWith("-large")) 2f else 1f
        assertEquals("Actual Activity must receive the requested system font scale", expectedFontScale, configuration.fontScale, 0.01f)
        val bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(dir, "$name.png").outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        File(dir, "$name.device.txt").writeText(
            "fontScale=${configuration.fontScale};densityDpi=${configuration.densityDpi};" +
                "widthDp=${configuration.screenWidthDp};heightDp=${configuration.screenHeightDp};" +
                "screenshot=${bitmap.width}x${bitmap.height}\n",
        )
        File(dir, "$name.semantics.txt").writeText(
            compose.onAllNodes(isRoot()).fetchSemanticsNodes().joinToString("\n") { it.config.toString() },
        )
    }

    @Test fun actualActiveModelAndIndependentGroupPreview() {
        mount()
        compose.onNodeWithText("→ Matching Beta").assertIsDisplayed()
        compose.onNodeWithText("→ Matching Alpha").assertIsDisplayed()
        screenshot("01-active-second-model")
        compose.onNodeWithText("Secondary audit group").performClick()
        compose.runOnIdle { assertEquals("secondary", selectedGroup.value) }
        screenshot("02-group-transition")
    }

    @Test fun searchShowsEveryMatchAndClearRestoresCollapsedState() {
        mount()
        compose.onNode(hasSetTextAction()).performTextInput(" matching ")
        compose.onNodeWithText("Matching Alpha", substring = false).assertExists()
        compose.onNodeWithText("Matching Beta", substring = false).assertExists()
        compose.onNodeWithText("Hidden Sentinel").assertDoesNotExist()
        screenshot("03-search-all-provider-matches")
        compose.onNodeWithText("Matching Beta", substring = false).performClick()
        compose.runOnIdle { assertEquals("second", selectedCallback); assertNull(selectedGroup.value) }
        compose.onNodeWithContentDescription(context.getString(R.string.model_picker_search_clear)).performClick()
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Audit Provider"))
        compose.onNodeWithText("Matching Beta", substring = false).assertExists()
        compose.onNodeWithText("Matching Alpha", substring = false).assertDoesNotExist()
        screenshot("04-clear-restores-provider-summary")
    }

    @Test fun emptySearchDismissAndReopenHaveRecoverableState() {
        mount()
        compose.onNode(hasSetTextAction()).performTextInput("zzzz-no-synthetic-match")
        compose.onNodeWithText(context.getString(R.string.model_picker_no_results)).assertIsDisplayed()
        screenshot("05-empty-search")
        compose.onNodeWithText(context.getString(R.string.model_picker_done)).performClick()
        compose.onNodeWithText("Reopen audit picker").assertIsDisplayed().performClick()
        compose.onNodeWithText("Primary audit group").assertIsDisplayed()
        compose.onNodeWithText("→ Matching Beta").assertIsDisplayed()
        screenshot("06-reopened-selection-preserved")
    }

    @Test fun longGroupNamesAndSystemFontScaleRemainInspectable() {
        mount(longNames = true)
        compose.onNodeWithText("Primary multilingual group 长名称测试 長いモデルグループ").assertIsDisplayed()
        screenshot("07-large-font-long-group")
        compose.onNodeWithText(context.getString(R.string.model_picker_done)).assertIsDisplayed()
    }
}
