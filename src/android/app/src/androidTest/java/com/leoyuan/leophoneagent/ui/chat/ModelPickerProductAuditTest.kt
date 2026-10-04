package com.leoyuan.leophoneagent.ui.chat

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.data.model.*
import com.leoyuan.leophoneagent.data.db.ProviderDatabase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
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
    private lateinit var palette: ColorScheme

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
                val colors = MaterialTheme.colorScheme
                SideEffect { palette = colors }
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

    private fun assertTextContrast(text: String, background: Color) {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(text, substring = false, useUnmergedTree = true)
            .performSemanticsAction(SemanticsActions.GetTextLayoutResult) { action ->
                assertTrue(action(layouts))
            }
        assertEquals("Expected one actual text layout for $text", 1, layouts.size)
        val foreground = layouts.single().layoutInput.style.color
        assertTrue("Actual text foreground must be explicit for $text", foreground != Color.Unspecified)
        val foregroundLuminance = foreground.compositeOver(background).luminance()
        val backgroundLuminance = background.luminance()
        val ratio = (maxOf(foregroundLuminance, backgroundLuminance) + 0.05f) /
            (minOf(foregroundLuminance, backgroundLuminance) + 0.05f)
        assertTrue("Actual text $text contrast $ratio must be at least4.5:1", ratio >= 4.5f)
    }

    private fun phase(name: String) {
        android.util.Log.i("ModelPickerAudit", "$name elapsedRealtimeMs=${android.os.SystemClock.elapsedRealtime()}")
    }

    private fun assertFixtureForeground(stage: String) {
        val root = requireNotNull(instrumentation.uiAutomation.rootInActiveWindow) {
            "No real foreground window at $stage; Compose semantics alone cannot certify visible UI"
        }
        try {
            val actualPackage = root.packageName?.toString()
            phase("foreground:$stage:$actualPackage")
            assertEquals("A system/other-app overlay invalidates product UI evidence at $stage", context.packageName, actualPackage)
        } finally {
            @Suppress("DEPRECATION")
            root.recycle()
        }
    }

    private fun screenshot(name: String) {
        phase("screenshot:$name:start")
        compose.waitForIdle()
        assertFixtureForeground("before-$name")
        val profile = InstrumentationRegistry.getArguments().getString("auditProfile") ?: "unspecified"
        // AGP collects this directory before uninstalling the test application.
        val outputBase = InstrumentationRegistry.getArguments().getString("additionalTestOutputDir")
            ?.let(::File)
            ?: File(requireNotNull(context.externalMediaDirs.firstOrNull()), "additional_test_output")
        val dir = File(outputBase, profile).apply { check(mkdirs() || isDirectory) }
        val configuration = compose.activity.resources.configuration
        val expectedFontScale = if (profile.endsWith("-large")) 2f else 1f
        assertEquals("Actual Activity must receive the requested system font scale", expectedFontScale, configuration.fontScale, 0.01f)
        phase("screenshot:$name:capture")
        val bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(dir, "$name.png").outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        assertFixtureForeground("after-$name")
        File(dir, "$name.device.txt").writeText(
            "fontScale=${configuration.fontScale};densityDpi=${configuration.densityDpi};" +
                "widthDp=${configuration.screenWidthDp};heightDp=${configuration.screenHeightDp};" +
                "screenshot=${bitmap.width}x${bitmap.height}\n",
        )
        fun describe(node: SemanticsNode, depth: Int = 0): String = buildString {
            append("  ".repeat(depth))
            append("id=${node.id}; bounds=${node.boundsInRoot}; touch=${node.touchBoundsInRoot}; ${node.config}\n")
            node.children.forEach { append(describe(it, depth + 1)) }
        }
        File(dir, "$name.semantics.txt").writeText(
            compose.onAllNodes(isRoot()).fetchSemanticsNodes().joinToString("\n") { describe(it) },
        )
        bitmap.recycle()
        phase("screenshot:$name:complete")
    }

    @Test fun immediateRepositoryLoadPreservesEmptyAndExistingConfiguration() {
        // This entire APK runs in a fresh disposable Application. Only this
        // fixture's synthetic database/preferences are touched, never user data.
        val database = ProviderDatabase.getInstance(context)
        val prefs = context.getSharedPreferences("provider_config", android.content.Context.MODE_PRIVATE)
        fun assertLoaded(repository: ProviderRepository) {
            // Unconfined + loadConfig's runBlocking makes completion occur
            // inside construction, before later field initializers could run.
            assertTrue(repository.configLoaded.value)
            runBlocking { withTimeout(5_000) { repository.awaitConfigLoaded() } }
        }
        database.clearAllTables()
        assertTrue(prefs.edit().clear().commit())
        try {
            val empty = ProviderRepository(context, Dispatchers.Unconfined)
            assertLoaded(empty)
            assertTrue(empty.config.value.instances.isEmpty())
            val persisted = ProviderConfig(
                instances = mutableListOf(ProviderInstance("startup-provider", "Saved provider", ProviderType.openAI, ProviderCredential.apiKey)),
                modelEntries = mutableListOf(ModelEntry("startup-provider", LLMModel("saved-model", "Saved model", "OpenAI"), uuid = "legacy-saved-entry")),
                modelGroups = mutableListOf(ModelGroup("saved-group", "Saved group", mutableListOf("legacy-saved-entry"))),
            )
            assertTrue(prefs.edit().putString("config", Json.encodeToString(persisted)).commit())
            val loaded = ProviderRepository(context, Dispatchers.Unconfined)
            assertLoaded(loaded)
            assertEquals("Saved provider", loaded.config.value.instances.single().label)
            assertEquals("saved-model", loaded.config.value.modelEntries.single().baseModel.id)
            assertEquals("startup-provider/saved-model", loaded.config.value.modelEntries.single().uuid)
            assertEquals(listOf("startup-provider/saved-model"), loaded.config.value.modelGroups.single().memberEntryIds)
            // Re-open the actual committed Room state, not a fake loader result.
            val reopened = ProviderRepository(context, Dispatchers.Unconfined)
            assertLoaded(reopened)
            assertEquals(loaded.config.value, reopened.config.value)
        } finally {
            database.clearAllTables()
            assertTrue(prefs.edit().clear().commit())
        }
    }

    @Test fun expandCollapseControlsAreNamedAndUsable() {
        mount()
        fun control(expand: Boolean, label: String): SemanticsNodeInteraction {
            val description = context.getString(
                if (expand) R.string.model_picker_expand_section else R.string.model_picker_collapse_section,
                label,
            )
            val node = compose.onNodeWithContentDescription(description)
            node.assertIsDisplayed().assertHasClickAction()
            val bounds = node.fetchSemanticsNode().touchBoundsInRoot
            val density = compose.activity.resources.displayMetrics.density
            assertTrue("Named control must have at least48dp touch width: $description", bounds.width / density >= 47.99f)
            assertTrue("Named control must have at least48dp touch height: $description", bounds.height / density >= 47.99f)
            return node
        }
        control(true, "Primary audit group").performClick()
        compose.onNodeWithText("Matching Alpha", substring = false).assertIsDisplayed().performClick()
        compose.runOnIdle {
            assertEquals("primary", selectedGroup.value)
            assertEquals("first", selectedEntry.value)
        }
        control(false, "Primary audit group").performClick()
        compose.onNode(hasScrollToIndexAction()).performScrollToNode(hasText("Audit Provider"))
        control(true, "Audit Provider").performClick()
        compose.onNodeWithText("Matching Beta", substring = false).assertExists()
        control(false, "Audit Provider").performClick()
        compose.onNodeWithText("Matching Beta", substring = false).assertDoesNotExist()
        screenshot("08-named-provider-control")
    }

    @Test fun actualActiveModelAndIndependentGroupPreview() {
        mount()
        compose.onNodeWithText("→ Matching Beta").assertIsDisplayed()
        compose.onNodeWithText("→ Matching Alpha").assertIsDisplayed()
        assertTextContrast("→ Matching Beta", palette.surfaceContainerHigh)
        assertTextContrast(context.getString(R.string.model_picker_default_badge), palette.tertiaryContainer)
        assertTextContrast(context.getString(R.string.model_picker_done), palette.surfaceContainerLow)
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
        assertTextContrast("audit-first", palette.surfaceContainerHigh)
        assertTextContrast(context.getString(R.string.model_picker_active_badge), palette.secondaryContainer)
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
        phase("empty:start")
        mount()
        phase("empty:mounted")
        compose.onNode(hasSetTextAction()).performTextInput("zzzz-no-synthetic-match")
        phase("empty:typed")
        compose.onNodeWithText(context.getString(R.string.model_picker_no_results)).assertIsDisplayed()
        screenshot("05-empty-search")
        compose.onNodeWithText(context.getString(R.string.model_picker_done)).performClick()
        phase("empty:dismiss-clicked")
        compose.onNodeWithText("Reopen audit picker").assertIsDisplayed().performClick()
        phase("empty:reopen-clicked")
        compose.onNodeWithText("Primary audit group").assertIsDisplayed()
        compose.onNodeWithText("→ Matching Beta").assertIsDisplayed()
        screenshot("06-reopened-selection-preserved")
        phase("empty:complete")
    }

    @Test fun longGroupNamesAndSystemFontScaleRemainInspectable() {
        mount(longNames = true)
        compose.onNodeWithText("Primary multilingual group 长名称测试 長いモデルグループ").assertIsDisplayed()
        screenshot("07-large-font-long-group")
        compose.onNodeWithText(context.getString(R.string.model_picker_done)).assertIsDisplayed()
    }
}
