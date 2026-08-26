import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}

// Build-time customization values that must NOT ship in the public
// open-source mirror. `provider-customization.properties` is tracked in the PRIVATE
// MinisApp repo (with real values) and listed under `private:` in
// PUBLISH_MANIFEST.yml so it is never synced; the public repo ships only
// `provider-customization.properties.example` (empty values). A build without a
// configured value compiles fine but fails at runtime the first time the
// value is required (see ClaudeOAuthManager). See docs/PUBLISH_POLICY.md.
val appCustomization = Properties().apply {
    val f = rootProject.file("app/provider-customization.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun customizationValue(key: String): String =
    (appCustomization.getProperty(key) ?: "").replace("\"", "\\\"")

android {
    namespace = "com.leoyuan.leophoneagent"
    // [T-android-dynamic-island] Bumped 35→36 so the Android 16 (Baklava)
    // Live Updates APIs — Notification.ProgressStyle, FLAG_PROMOTED_ONGOING,
    // NotificationManager.canPostPromotedNotifications(), setShortCriticalText —
    // are available to compile against. targetSdk stays 35 to avoid pulling in
    // Android 16 behavior changes; the Live Updates path is runtime-gated on
    // Build.VERSION.SDK_INT >= 36 (see DynamicIslandSupport / AgentForegroundService).
    compileSdk = 36
    ndkVersion = "27.0.12077973"

    defaultConfig {
        applicationId = "com.leoyuan.leophoneagent"
        minSdk = 26
        targetSdk = 35
        versionCode = 100015
        versionName = "1.0.0-alpha.15"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // System prompt prefix required by Anthropic for Claude Code OAuth
        // credentials. Empty in the public mirror (see provider-customization.properties).
        buildConfigField(
            "String",
            "ANTHROPIC_OAUTH_IDENTIFIER_PROMPT",
            "\"${customizationValue("ANTHROPIC_OAUTH_IDENTIFIER_PROMPT")}\""
        )

        ndk {
            abiFilters += listOf("arm64-v8a")
        }

        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++17"
                arguments += "-DANDROID_STL=c++_shared"
                arguments += "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON"
            }
        }
    }

    flavorDimensions += "capability"
    productFlavors {
        create("standard") {
            dimension = "capability"
            buildConfigField("boolean", "POWER_FEATURES_ENABLED", "false")
            manifestPlaceholders["powerFeaturesEnabled"] = "false"
            resValue("string", "app_display_name", "LeoPhoneAgent")
        }
        create("power") {
            dimension = "capability"
            applicationIdSuffix = ".power"
            versionNameSuffix = "-power"
            buildConfigField("boolean", "POWER_FEATURES_ENABLED", "true")
            manifestPlaceholders["powerFeaturesEnabled"] = "true"
            resValue("string", "app_display_name", "LeoPhoneAgent Power")
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Production release signing must be supplied by the distributor.
            // Personal alpha APKs may opt in explicitly; this prevents an
            // accidental store/release build from silently adopting the
            // Android debug identity and creating an irreversible upgrade path.
            if (providers.gradleProperty("leophone.allowDebugReleaseSigning").orNull == "true") {
                signingConfig = signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        // PRoot and its loader are executed from nativeLibraryDir. Express
        // extraction through AGP's supported packaging API instead of the
        // deprecated manifest attribute so Release packaging stays explicit.
        jniLibs.useLegacyPackaging = true
    }

    androidResources {
        noCompress += listOf("tar.gz", "proot-aarch64")
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    lint {
        // English is the product fallback for locales whose community
        // translation is partial. Simplified Chinese completeness is enforced
        // separately by verifyChineseResources and remains a hard build gate.
        disable += "MissingTranslation"
        textReport = true
        htmlReport = true
    }

}

// [perf/丝滑度] Compose 编译器报告。
//
// why: 判断"某个 composable 为什么不跳过重组"，唯一可靠的依据是编译器自己
// 输出的 stability / skippability 报告；靠读代码猜参数稳定性会漏。
// 之前这个模块完全没开过，所以谁 restartable、谁 skippable、哪些形参被判为
// unstable 全是盲区。
//
// 默认关闭：只有显式传 -PcomposeMetrics 时才生成，普通构建（含 CI）零影响，
// 不会多产出文件、不会改变编译产物。
//
// 用法：
//   ./gradlew :app:assembleStandardRelease -PcomposeMetrics
//   报告落在 app/build/compose-metrics 与 app/build/compose-reports，
//   看 *-composables.txt 里 `restartable skippable` 的比例，
//   以及 *-classes.txt 里被判为 unstable 的类。
composeCompiler {
    val enabled = project.findProperty("composeMetrics") != null
    if (enabled) {
        metricsDestination.set(layout.buildDirectory.dir("compose-metrics"))
        reportsDestination.set(layout.buildDirectory.dir("compose-reports"))
    }
}

// [T-bash-on-demand] Keep the shared bashism rule table / test vectors as a
// SINGLE source of truth (src/shared/bashism) — copy into assets at build
// time instead of committing duplicate JSON. iOS references the same files as
// bundle resources. Runs before every asset merge so debug/release stay fresh.
val copyBashismRules by tasks.registering(Copy::class) {
    from(rootProject.file("../shared/bashism")) {
        include("bashism_rules.json", "bashism_test_vectors.json")
    }
    into(layout.projectDirectory.dir("src/main/assets/bashism"))
}
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }
    .configureEach { dependsOn(copyBashismRules) }
tasks.named("preBuild") { dependsOn(copyBashismRules) }

// [T-android-debugserver-skill] Stage the debug-server skill + an Android
// reference client into the DEBUG-ONLY asset source set, so the debug server
// can serve them over GET /skill (mirrors the iOS "Generate Debug Skill" build
// phase). Single source of truth stays .claude/skills/debug-server/.
//
// Wired to DEBUG asset merges only: src/debug/assets never reaches a release
// APK, so the tooling docs can't ship to users. `assets` is also declared as an
// output so Gradle re-runs this when the skill changes but skips it otherwise.
val stageDebugSkillAssets by tasks.registering(Exec::class) {
    val script = rootProject.file("../../scripts/gen_debug_skill_android.sh")
    val skillDir = rootProject.file("../../.claude/skills/debug-server")
    onlyIf { script.exists() }
    // The public/Leo tree may intentionally omit the private debug skill.
    // Gradle validates a missing inputs.dir before onlyIf/optional can skip
    // it, while the staging script already emits a safe placeholder. Register
    // the directory only when it actually exists.
    if (skillDir.exists()) inputs.dir(skillDir)
    inputs.file(script).optional()
    outputs.dir(layout.projectDirectory.dir("src/debug/assets/debug-skill"))
    commandLine("bash", script.absolutePath)
}
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") && it.name.contains("Debug") }
    .configureEach { dependsOn(stageDebugSkillAssets) }

dependencies {
    // Compose BOM
    val composeBom = platform("androidx.compose:compose-bom:2025.09.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")

    // Core
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    // ProcessLifecycleOwner — used by XAIOAuthManager to detect Custom
    // Tab dismissal (T-xai-oauth-stop-resume port iOS d1dbdd5d).
    implementation("androidx.lifecycle:lifecycle-process:2.8.7")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.exifinterface:exifinterface:1.3.7")

    // Navigation
    implementation("androidx.navigation:navigation-compose:2.8.5")

    // Room
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // DataStore
    implementation("androidx.datastore:datastore-preferences:1.1.1")

    // Security (EncryptedSharedPreferences)
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // OkHttp
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-sse:4.12.0")

    // Kotlinx Serialization
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Coil (image loading)
    implementation("io.coil-kt:coil-compose:2.7.0")

    // Markdown rendering (mikepenz multiplatform-markdown-renderer)
    implementation("com.mikepenz:multiplatform-markdown-renderer-android:0.33.0")
    implementation("com.mikepenz:multiplatform-markdown-renderer-m3-android:0.33.0")

    // Chrome Custom Tabs (in-app browser for OAuth)
    implementation("androidx.browser:browser:1.8.0")

    // T-pwa-1: WebViewAssetLoader serves pinned PWA HTML under
    // https://appassets.androidplatform.net/ inside PwaActivity, so
    // sibling CSS/JS resolve against the file's parent dir without
    // granting WebView raw file:// access.
    implementation("androidx.webkit:webkit:1.12.1")

    // Drag-to-reorder for LazyColumn
    implementation("sh.calvin.reorderable:reorderable:2.4.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    // Recoverable scheduled work after process death / boot / timezone change.
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    // Fold posture (HALF_OPENED tabletop / book) for the chat workspace.
    implementation("androidx.window:window:1.3.0")

    // T283: ACRA — local crash report capture. acra-core only (no http
    // sender, no network permission). CrashFileSender writes reports to
    // filesDir/logs/ where LogManagementScreen surfaces them.
    implementation("ch.acra:acra-core:5.12.0")

    // T322: Shizuku SDK — offloads privileged Android system APIs (PackageManager,
    // PermissionManager, ActivityManager, AppOps, IInputManager, …) through a
    // user-installed Shizuku app running as adb shell (uid=2000) or root. The CLI
    // surface `android-shizuku-cli` is a NativeOffloadHandler that forwards argv into
    // these hidden APIs via Shizuku's binder. `api` provides the manager binder
    // proxy + permission flow, `provider` registers the in-process content
    // provider that hosts the user-app side of the binder.
    //
    // [T-android-privileged-backend] AXManager (Axeron) needs NO extra
    // dependency: its server is a drop-in Shizuku-protocol implementation that
    // `sendBinder`s into the standard `<applicationId>.shizuku` ShizukuProvider
    // (verified against the installed APK). AxeronBackend therefore rides the
    // same `rikka.shizuku.Shizuku` client + provider declared above. The
    // earlier Axeron-API SDK route was dropped — it duplicated the
    // `moe.shizuku.*` classes (AGP checkDuplicateClasses failure) and pulled an
    // incompatible androidx.core / minSdk for zero added capability.
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")

    // Testing — JVM unit tests
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("org.json:json:20231013")

    // Testing — Instrumented (on-device) tests
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    androidTestImplementation("junit:junit:4.13.2")
}

val verifyChineseResources by tasks.registering {
    group = "verification"
    description = "Fails when a default Android string resource has no Simplified Chinese entry."
    val defaults = file("src/main/res/values/strings.xml")
    val chinese = file("src/main/res/values-zh/strings.xml")
    inputs.files(defaults, chinese)
    doLast {
        fun names(source: File): Set<String> {
            val document = javax.xml.parsers.DocumentBuilderFactory.newInstance()
                .newDocumentBuilder()
                .parse(source)
            return (0 until document.documentElement.childNodes.length)
                .map { document.documentElement.childNodes.item(it) }
                .filterIsInstance<org.w3c.dom.Element>()
                .mapNotNull { element ->
                    element.getAttribute("name")
                        .takeIf { it.isNotBlank() && element.getAttribute("translatable") != "false" }
                }
                .toSet()
        }
        val missing = names(defaults) - names(chinese)
        check(missing.isEmpty()) {
            "Missing Simplified Chinese resources: ${missing.sorted().joinToString()}"
        }
    }
}

val verifyChineseSettingsStrings by tasks.registering {
    group = "verification"
    description = "Rejects known user-facing English literals in Android settings UI source."
    val settingsSource = fileTree("src/main/java/com/leoyuan/leophoneagent/ui/settings") {
        include("**/*.kt")
    }
    inputs.files(settingsSource)
    doLast {
        val banned = setOf(
            "Back", "Selected", "Edit name", "Hide", "Show", "Delete Model",
            "Defaults", "Default Primary", "Default Sub", "Name saved",
            "No models in this group.", "Model no longer available",
            "Authentication failed", "Refresh model list", "Not connected", "Configured",
        )
        val failures = mutableListOf<String>()
        val literal = Regex("\\\"([^\\\"\\n]+)\\\"")
        settingsSource.files.sorted().forEach { source ->
            source.readLines().forEachIndexed { index, line ->
                literal.findAll(line).forEach { match ->
                    if (match.groupValues[1] in banned) {
                        failures += "${source.relativeTo(projectDir)}:${index + 1}: ${match.value}"
                    }
                }
            }
        }
        check(failures.isEmpty()) {
            "Hard-coded English settings UI strings found:\n${failures.joinToString("\n")}"
        }
    }
}

tasks.matching { it.name == "check" }.configureEach {
    dependsOn(verifyChineseResources, verifyChineseSettingsStrings)
}

// Ship the license, third-party notice, source offer, and privacy disclosure
// inside every APK without duplicating their repository source files.
val stageLegalAssets by tasks.registering(Copy::class) {
    from(rootProject.file("../../LICENSE")) { rename { "GPL-3.0.txt" } }
    from(rootProject.file("../../THIRD_PARTY_LICENSES.md"))
    from(rootProject.file("../../docs/ANDROID_PRIVACY.md"))
    from(layout.projectDirectory.file("src/main/legal/SOURCE_OFFER.txt"))
    into(layout.buildDirectory.dir("generated/legalAssets/legal"))
}
android.sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/legalAssets"))
tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }
    .configureEach { dependsOn(stageLegalAssets) }
tasks.matching { it.name.contains("Lint", ignoreCase = true) }
    .configureEach { dependsOn(stageLegalAssets) }
