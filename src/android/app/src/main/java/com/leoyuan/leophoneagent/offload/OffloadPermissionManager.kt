package com.leoyuan.leophoneagent.offload

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.coroutines.resume

/**
 * Manages offload permissions for privacy-sensitive agent tools.
 * Three levels: BYPASS (auto-allow), ASK_ONCE (per-session), NOT_ALLOWED.
 *
 * Mirrors iOS OffloadPermissionManager behavior.
 */
object OffloadPermissionManager {

    enum class PermissionLevel {
        BYPASS,      // Always allowed
        ASK_ONCE,    // Ask once per session
        NOT_ALLOWED, // Always denied
    }

    data class PermissionRequest(
        val toolName: String,
        val toolTitle: String,
        val description: String,
        val sessionId: String,
        val singleUseOnly: Boolean = false,
    )

    enum class PermissionCategory(val displayName: String) {
        PRIVACY("Privacy"),
        MEDIA("Media"),
        SYSTEM("System"),
        // T330: privileged automation CLIs (Shizuku binder / Accessibility
        // service). These run via the offload bridge as shell tools, not as
        // named LLM tool calls, so the gate happens inside the
        // NativeOffloadHandler entry point rather than ChatViewModel.
        INTEGRATIONS("Integrations"),
    }

    data class ToolPermissionInfo(
        val toolName: String,
        val displayName: String,
        val category: PermissionCategory,
        val defaultLevel: PermissionLevel,
        /**
         * Mirrors iOS `OffloadCommandInfo.showInSettings`. When false the tool
         * is registered (so the dialog/check pipeline still recognises its
         * name) but hidden from the Permissions settings page — Media + System
         * tools carry no personal data and have no reason to clutter the UI.
         */
        val showInSettings: Boolean = true,
    )

    /**
     * Registry of all tools and their permission categories. Defaults are
     * BYPASS across the board to mirror iOS — the user opted into running an
     * agent app, so background access is permitted unless they explicitly
     * downgrade an entry to ASK_ONCE / NOT_ALLOWED. Tools omitted from this
     * registry fail closed as NOT_ALLOWED; every new bridge capability must
     * declare its permission contract here before it can execute.
     */
    val toolRegistry: List<ToolPermissionInfo> = listOf(
        // Privacy — user-configurable, visible in Settings.
        ToolPermissionInfo("calendar", "Calendar", PermissionCategory.PRIVACY, PermissionLevel.BYPASS),
        ToolPermissionInfo("location", "Location", PermissionCategory.PRIVACY, PermissionLevel.BYPASS),
        ToolPermissionInfo("clipboard", "Clipboard", PermissionCategory.PRIVACY, PermissionLevel.BYPASS),
        ToolPermissionInfo("contacts", "Contacts", PermissionCategory.PRIVACY, PermissionLevel.BYPASS),
        ToolPermissionInfo("photos", "Photos", PermissionCategory.PRIVACY, PermissionLevel.BYPASS),
        // Media — no personal data, hidden from Settings.
        ToolPermissionInfo("speak", "Text-to-Speech", PermissionCategory.MEDIA, PermissionLevel.BYPASS, showInSettings = false),
        ToolPermissionInfo("media_player", "Media Player", PermissionCategory.MEDIA, PermissionLevel.BYPASS, showInSettings = false),
        ToolPermissionInfo("speech_recognition", "Speech Recognition", PermissionCategory.MEDIA, PermissionLevel.BYPASS, showInSettings = false),
        // System — no personal data, hidden from Settings.
        ToolPermissionInfo("alarm", "Alarms & Timers", PermissionCategory.SYSTEM, PermissionLevel.BYPASS, showInSettings = false),
        ToolPermissionInfo("weather", "Weather", PermissionCategory.SYSTEM, PermissionLevel.BYPASS, showInSettings = false),
        ToolPermissionInfo("notification", "Notifications", PermissionCategory.SYSTEM, PermissionLevel.BYPASS, showInSettings = false),
        ToolPermissionInfo("device_info", "Device Info", PermissionCategory.SYSTEM, PermissionLevel.BYPASS, showInSettings = false),
        // review P0#3: `android-open` 过去**根本没有注册**，于是
        //   (a) OffloadGate 无从校验（handler 里也确实没调 enforce），
        //   (b) 设置页看不见、用户关不掉。
        // 归 SYSTEM 而不是 PRIVACY：它不读取任何个人数据，注册进来主要是为了
        // 给用户一个可见的总开关；真正的注入面（`intent:` URI 里编码显式
        // component 去拉起任意 exported activity）已经在
        // OpenOffloadHandler 里按 URI 形状直接拒绝掉了，不该靠"每次弹窗"来兜。
        // showInSettings = true：这是唯一一个能把用户带出 App 的工具，
        // 值得在权限页露面。
        ToolPermissionInfo("open", "Open Links & Apps", PermissionCategory.SYSTEM, PermissionLevel.BYPASS),
        ToolPermissionInfo("apps", "Installed Apps", PermissionCategory.SYSTEM, PermissionLevel.BYPASS, showInSettings = false),
        // T330: integrations — opt-in by default. These tools can drive
        // other apps and read on-screen content, so the safer posture is
        // NOT_ALLOWED until the user picks otherwise even when the
        // underlying system layer (Shizuku binder / Accessibility service)
        // is already authorized.
        ToolPermissionInfo("a11y_cli", "android-a11y-cli", PermissionCategory.INTEGRATIONS, PermissionLevel.NOT_ALLOWED),
        ToolPermissionInfo("shizuku_cli", "android-shizuku-cli", PermissionCategory.INTEGRATIONS, PermissionLevel.NOT_ALLOWED),
        ToolPermissionInfo("shizuku_dangerous", "Privileged destructive command", PermissionCategory.INTEGRATIONS, PermissionLevel.ASK_ONCE, showInSettings = false),
    )

    /** Stable session-id used by NativeOffloadHandlers when calling
     *  [checkPermission] from the offload IPC thread. The shell-CLI gate
     *  (T330) lives outside ChatViewModel.executeTool, so there's no
     *  per-chat-session id available to scope ASK_ONCE grants. We use
     *  one process-lifetime grant slot instead — the user "Always Allow"
     *  upgrades naturally to BYPASS via [respondToRequest]. */
    const val OFFLOAD_GLOBAL_SESSION_ID = "offload-global"

    private lateinit var prefs: SharedPreferences

    /** Session-scoped grants for ASK_ONCE tools. Populated by the
     *  "Allow in this session" dialog response. Cleared when the
     *  hosting session ends (or process death — see
     *  OFFLOAD_GLOBAL_SESSION_ID for offload-CLI-backed tools, which
     *  share one process-lifetime slot). */
    private val sessionGrants = mutableMapOf<String, MutableSet<String>>() // sessionId -> set of toolNames

    /** T338: session-scoped denials. Populated by the "Deny in this
     *  session" dialog response. Once a tool is in here for a given
     *  session, [checkPermission] returns false without re-prompting
     *  — prevents the agent from spamming the user with the same
     *  request after they already said no. Cleared with
     *  [clearSessionGrants]. */
    private val sessionDenials = mutableMapOf<String, MutableSet<String>>() // sessionId -> set of toolNames

    /** Active permission request waiting for user response. */
    private val _pendingRequest = MutableStateFlow<PermissionRequest?>(null)
    val pendingRequest: StateFlow<PermissionRequest?> = _pendingRequest.asStateFlow()

    private var pendingContinuation: kotlin.coroutines.Continuation<Response>? = null
    private val permissionPromptMutex = Mutex()

    // ── Android system runtime permission request (for location etc.) ──────────

    /** Result of a runtime permission or settings-gate flow. */
    enum class AndroidPermissionResult { GRANTED, DENIED, TIMEOUT }

    /** Timeout for a single system permission dialog round-trip. */
    const val SYSTEM_DIALOG_TIMEOUT_MS: Long = 120_000L

    /** Timeout for the "bounce the user to a settings page" flow. */
    const val SETTINGS_GATE_TIMEOUT_MS: Long = 120_000L

    data class AndroidPermissionRequest(val permissions: List<String>)

    private val _pendingAndroidPermission = MutableStateFlow<AndroidPermissionRequest?>(null)
    val pendingAndroidPermission: StateFlow<AndroidPermissionRequest?> = _pendingAndroidPermission.asStateFlow()

    private var androidPermissionContinuation: kotlin.coroutines.Continuation<AndroidPermissionResult>? = null

    /**
     * Ask the UI layer to drive the system runtime-permission flow for the
     * given permissions. The UI is responsible for:
     *
     *  - Detecting whether the permission has already been permanently denied
     *    (so the system dialog would be a no-op). If so, responding with
     *    [AndroidPermissionResult.DENIED] so the caller can fall back to the
     *    in-app "go to settings" flow via [requestSettingsGate].
     *  - Otherwise launching the `RequestMultiplePermissions` contract and
     *    returning the result.
     *
     * The call is suspended until the UI responds or [SYSTEM_DIALOG_TIMEOUT_MS]
     * elapses.
     */
    suspend fun requestAndroidPermission(permissions: List<String>): AndroidPermissionResult {
        val timed = withTimeoutOrNull(SYSTEM_DIALOG_TIMEOUT_MS) {
            suspendCancellableCoroutine<AndroidPermissionResult> { cont ->
                androidPermissionContinuation = cont
                _pendingAndroidPermission.value = AndroidPermissionRequest(permissions)
                cont.invokeOnCancellation {
                    _pendingAndroidPermission.value = null
                    androidPermissionContinuation = null
                }
            }
        }
        if (timed == null) {
            // Timed out — clear the pending request so the UI doesn't fire a
            // stale permission dialog later.
            _pendingAndroidPermission.value = null
            androidPermissionContinuation = null
            return AndroidPermissionResult.TIMEOUT
        }
        return timed
    }

    /** Called from UI after the system permission dialog returns. */
    fun respondToAndroidPermission(result: AndroidPermissionResult) {
        _pendingAndroidPermission.value = null
        androidPermissionContinuation?.resume(result)
        androidPermissionContinuation = null
    }

    /** Overload kept for callers that only have a granted/denied bool. */
    fun respondToAndroidPermission(granted: Boolean) =
        respondToAndroidPermission(
            if (granted) AndroidPermissionResult.GRANTED else AndroidPermissionResult.DENIED
        )

    // ── In-app "go to settings" gate ───────────────────────────────────────────

    /**
     * Describes a gate we can't resolve with the standard permission dialog:
     * either the user has already permanently denied the runtime permission,
     * or the capability (e.g. Notification Access) requires a trip to a
     * system settings page.
     */
    data class SettingsGateRequest(
        /** Stable id for the gate (e.g. "POST_NOTIFICATIONS" or "notification_access"). */
        val id: String,
        /** Title shown in the in-app AlertDialog. */
        val title: String,
        /** Body shown in the in-app AlertDialog. */
        val message: String,
        /** Intent action used to open the appropriate settings page. */
        val settingsAction: String,
        /**
         * Set when the target settings page is "Application details" and the
         * Intent must include a `package:<pkg>` data URI.
         */
        val requiresPackageUri: Boolean,
        /** "Allow" button label for the in-app dialog. */
        val positiveLabel: String = "Open Settings",
        /** "Cancel" button label for the in-app dialog. */
        val negativeLabel: String = "Cancel",
    )

    /** What the UI actor decided after the dialog closed. */
    enum class SettingsGateDecision { OPEN, CANCEL }

    private val _pendingSettingsGate = MutableStateFlow<SettingsGateRequest?>(null)
    val pendingSettingsGate: StateFlow<SettingsGateRequest?> = _pendingSettingsGate.asStateFlow()

    private var settingsGateContinuation: kotlin.coroutines.Continuation<SettingsGateDecision>? = null

    /**
     * Show an in-app dialog explaining why a settings trip is needed, then
     * (if the user accepts) wait up to [SETTINGS_GATE_TIMEOUT_MS] polling
     * [check] for success.
     *
     * Returns:
     *  - [AndroidPermissionResult.GRANTED] if [check] succeeds within the
     *    polling window.
     *  - [AndroidPermissionResult.DENIED] if the user cancels the dialog.
     *  - [AndroidPermissionResult.TIMEOUT] if the user accepts but doesn't
     *    complete the grant within the window.
     */
    suspend fun requestSettingsGate(
        request: SettingsGateRequest,
        check: () -> Boolean,
    ): AndroidPermissionResult {
        val decision = suspendCancellableCoroutine<SettingsGateDecision> { cont ->
            settingsGateContinuation = cont
            _pendingSettingsGate.value = request
            cont.invokeOnCancellation {
                _pendingSettingsGate.value = null
                settingsGateContinuation = null
            }
        }
        if (decision == SettingsGateDecision.CANCEL) return AndroidPermissionResult.DENIED

        val granted = withTimeoutOrNull(SETTINGS_GATE_TIMEOUT_MS) {
            while (true) {
                if (check()) return@withTimeoutOrNull true
                delay(500L)
            }
            @Suppress("UNREACHABLE_CODE") false
        }
        return when (granted) {
            true -> AndroidPermissionResult.GRANTED
            else -> AndroidPermissionResult.TIMEOUT
        }
    }

    /**
     * Poll [check] every [intervalMs] for up to [timeoutMs] after a DENIED
     * result from [requestAndroidPermission]. Catches the "grant propagation
     * race" — the system dialog returned before the PackageManager fully
     * committed the grant, or the user was still mid-tap when DENIED fired.
     */
    suspend fun pollForPermissionGrant(
        check: () -> Boolean,
        timeoutMs: Long = 5_000L,
        intervalMs: Long = 500L,
    ): Boolean {
        val granted = withTimeoutOrNull(timeoutMs) {
            while (true) {
                if (check()) return@withTimeoutOrNull true
                delay(intervalMs)
            }
            @Suppress("UNREACHABLE_CODE") false
        }
        return granted == true
    }

    /** Called from UI after the in-app "go to settings" dialog closes. */
    fun respondToSettingsGate(decision: SettingsGateDecision) {
        _pendingSettingsGate.value = null
        settingsGateContinuation?.resume(decision)
        settingsGateContinuation = null
    }

    /**
     * Android's `shouldShowRequestPermissionRationale` returns false in two
     * cases: (a) the app has never asked, and (b) the user permanently
     * denied. We track (a) ourselves so the UI can distinguish them.
     */
    fun hasAskedForPermission(context: Context, permission: String): Boolean {
        val p = context.getSharedPreferences("offload_permissions_asked", Context.MODE_PRIVATE)
        return p.getBoolean(permission, false)
    }

    fun markPermissionAsked(context: Context, permission: String) {
        context.getSharedPreferences("offload_permissions_asked", Context.MODE_PRIVATE)
            .edit().putBoolean(permission, true).apply()
    }

    // ── 远程身体在线时的隐私提级 ────────────────────────────────────────────

    /**
     * 「允许本机接受远程任务」是否打开（由 `RelayBodyService.restart` 写入）。
     *
     * why（review P0#2）：这三件事叠在一起，等于远程可以零确认读走通讯录 /
     * 定位 / 相册 / 剪贴板 / 日历：
     *   1. `MinisHarnessRouter` 声明 `approval_events: false`，任何 `/approval`
     *      一律 409（`PUSH_EVENTS` 里虽然列了 `approval.request`，但全仓没有
     *      任何地方 emit 它 —— 是死代码）；
     *   2. PRIVACY 组五个工具的默认等级全是 BYPASS；
     *   3. 于是远程调这些工具时，手机上什么都不弹、什么都不留痕。
     *
     * 本地单机时 BYPASS 是合理的（用户自己在用自己的 Agent）；一旦本机变成
     * 可被远程驱动的"身体"，同一个 BYPASS 就变成了远程无声取数。这里在
     * bodyEnabled 打开期间，把 PRIVACY 组的**有效**等级强制提到 ASK_ONCE，
     * 用户在设置里存的值不动（见 [getConfiguredLevel]）。
     *
     * 注意：INTEGRATIONS 组（a11y / shizuku）默认就是 NOT_ALLOWED，
     * 未注册工具 fail-closed —— 那两处本来就是对的，不动。
     */
    @Volatile
    private var remoteBodyEnabled: Boolean = false

    fun setRemoteBodyEnabled(enabled: Boolean) {
        remoteBodyEnabled = enabled
    }

    fun isRemoteBodyEnabled(): Boolean = remoteBodyEnabled

    /**
     * 判断"现在还有没有 UI 能把权限弹窗画出来"。
     *
     * 由 `MinisApp` 在 init 时注入（`::isAppForeground`）。为 null 时按
     * "未知 → 走超时路径"处理，避免测试/未接线场景下把所有 ASK_ONCE 全拒。
     */
    @Volatile
    private var promptHostProbe: (() -> Boolean)? = null

    fun setPromptHostProbe(probe: (() -> Boolean)?) {
        promptHostProbe = probe
    }

    fun init(context: Context) {
        prefs = context.getSharedPreferences("offload_permissions", Context.MODE_PRIVATE)
    }

    /**
     * 用户在设置里实际选择（或默认）的等级 —— 不含远程提级。
     * 设置页 / 调试 RPC 要显示的是这个值，否则开着远程身体时 UI 会显示成
     * 用户从没选过的 ASK_ONCE。
     */
    fun getConfiguredLevel(toolName: String): PermissionLevel {
        val info = toolRegistry.find { it.toolName == toolName }
            ?: return PermissionLevel.NOT_ALLOWED
        val stored = prefs.getString("level_$toolName", null)
        return if (stored != null) {
            try { PermissionLevel.valueOf(stored) } catch (_: Exception) { info.defaultLevel }
        } else {
            info.defaultLevel
        }
    }

    /** 实际执行时生效的等级（含远程身体在线时的 PRIVACY 提级）。 */
    fun getLevel(toolName: String): PermissionLevel {
        val info = toolRegistry.find { it.toolName == toolName }
            ?: return PermissionLevel.NOT_ALLOWED
        return effectiveLevel(info.category, getConfiguredLevel(toolName), remoteBodyEnabled)
    }

    /**
     * 提级规则本体，抽成纯函数以便单测（本仓 JVM 单测没有 Robolectric，
     * 走不到需要 Context 的 [getConfiguredLevel]）。
     *
     * 规则：只提级，不降级 —— 用户显式选了 NOT_ALLOWED 就仍然是 NOT_ALLOWED；
     * 已经是 ASK_ONCE 的不变；只有 PRIVACY 组的 BYPASS 会在远程身体在线时
     * 被抬到 ASK_ONCE。MEDIA / SYSTEM 不动（不含个人数据），
     * INTEGRATIONS 本来就默认 NOT_ALLOWED。
     */
    internal fun effectiveLevel(
        category: PermissionCategory,
        configured: PermissionLevel,
        remoteBody: Boolean,
    ): PermissionLevel = when {
        remoteBody &&
            category == PermissionCategory.PRIVACY &&
            configured == PermissionLevel.BYPASS -> PermissionLevel.ASK_ONCE
        else -> configured
    }

    fun setLevel(toolName: String, level: PermissionLevel) {
        prefs.edit().putString("level_$toolName", level.name).apply()
    }

    fun resetAll() {
        val editor = prefs.edit()
        for (tool in toolRegistry) {
            editor.remove("level_${tool.toolName}")
        }
        editor.apply()
    }

    /**
     * T338: dialog response shape. Replaces the older
     * `(allowed: Boolean, alwaysAllow: Boolean)` pair, which encoded
     * "Always Allow" as a persistent BYPASS upgrade. The new model is
     * strictly session-scoped — the user goes to Settings → Permissions
     * to make a permanent change.
     *
     *   ALLOW_SESSION  — grant for the rest of this session, no more
     *                    prompts for this tool until session ends.
     *   ALLOW_ONCE     — grant just this call; next call re-prompts.
     *   DENY_SESSION   — deny + remember the deny so the agent can't
     *                    keep nagging. Cleared with the session.
     */
    enum class Response { ALLOW_SESSION, ALLOW_ONCE, DENY_SESSION }

    /**
     * Check permission for a tool in the given session.
     * For ASK_ONCE, suspends until user responds via the dialog.
     * Returns true if allowed.
     */
    suspend fun checkPermission(
        toolName: String,
        toolTitle: String,
        sessionId: String,
        description: String? = null,
        singleUseOnly: Boolean = false,
    ): Boolean {
        val level = getLevel(toolName)
        if (singleUseOnly) {
            if (level == PermissionLevel.NOT_ALLOWED) return false
            return promptForPermission(toolName, toolTitle, sessionId, description, singleUseOnly = true)
        }
        return when (level) {
            PermissionLevel.BYPASS -> true
            PermissionLevel.NOT_ALLOWED -> false
            PermissionLevel.ASK_ONCE -> {
                // T338: a prior "Deny in this session" short-circuits
                // before any grants check or dialog so the agent can't
                // spam the user.
                val denials = sessionDenials.getOrPut(sessionId) { mutableSetOf() }
                if (toolName in denials) return false

                val grants = sessionGrants.getOrPut(sessionId) { mutableSetOf() }
                if (toolName in grants) return true

                promptForPermission(toolName, toolTitle, sessionId, description, singleUseOnly = false)
            }
        }
    }

    /**
     * 弹一次权限确认，等用户回答。
     *
     * why 加超时 + 无宿主快速失败（review P1#11）：原来这里持有一把**全局**
     * 互斥锁并无限期挂起，唯一的渲染方是 `ChatScreen` 里的
     * `OffloadPermissionDialog`。App 在后台 / Activity 已销毁时根本没人收
     * `pendingRequest`，于是：
     *   * 这次调用一直挂到 `streamPrompt` 的 10 分钟超时；
     *   * 这 10 分钟里，用户自己在前台碰任何 ASK_ONCE 工具，也一起卡在
     *     `permissionPromptMutex` 上 —— 一个远程会话锁死了全 App 的敏感工具。
     * 对比 [requestAndroidPermission] 早就有 120 秒超时，这里是漏的。
     *
     * 现在：
     *   1. 探到"没有 UI 宿主"就立刻 fail-closed（拒绝），不占锁、不等待；
     *   2. 有宿主时也只等 [PROMPT_TIMEOUT_MS]，超时按拒绝处理；
     *   3. 超时逻辑放在 `withLock` **内部**，保证锁的持有时长有上界。
     */
    private suspend fun promptForPermission(
        toolName: String,
        toolTitle: String,
        sessionId: String,
        description: String?,
        singleUseOnly: Boolean,
    ): Boolean {
        // 先于取锁判断：没有宿主时连锁都不该碰。
        if (promptHostProbe?.invoke() == false) return false
        return permissionPromptMutex.withLock {
            val denials = sessionDenials.getOrPut(sessionId) { mutableSetOf() }
            if (toolName in denials) return@withLock false
            // 排队等锁期间 App 可能已经切到后台，取到锁后再探一次。
            if (promptHostProbe?.invoke() == false) return@withLock false
            val info = toolRegistry.find { it.toolName == toolName }
            val response = withTimeoutOrNull(PROMPT_TIMEOUT_MS) {
                suspendCancellableCoroutine<Response> { cont ->
                    pendingContinuation = cont
                    _pendingRequest.value = PermissionRequest(
                        toolName = toolName,
                        toolTitle = toolTitle,
                        description = description ?: "Allow ${info?.displayName ?: toolName} access?",
                        sessionId = sessionId,
                        singleUseOnly = singleUseOnly,
                    )
                    cont.invokeOnCancellation {
                        _pendingRequest.value = null
                        pendingContinuation = null
                    }
                }
            }
            if (response == null) {
                // 超时：清掉悬空的 pending 请求，免得稍后又弹一个陈旧弹窗。
                // （invokeOnCancellation 通常已经清过，这里是防御性兜底。）
                _pendingRequest.value = null
                pendingContinuation = null
                return@withLock false
            }
            when (response) {
                Response.ALLOW_SESSION -> {
                    if (!singleUseOnly) sessionGrants.getOrPut(sessionId) { mutableSetOf() }.add(toolName)
                    true
                }
                Response.ALLOW_ONCE -> true
                Response.DENY_SESSION -> {
                    denials.add(toolName)
                    false
                }
            }
        }
    }

    /** 单次权限确认弹窗的最长等待时间，与 [SYSTEM_DIALOG_TIMEOUT_MS] 对齐。 */
    const val PROMPT_TIMEOUT_MS: Long = 120_000L

    /** Called from UI when user responds to the permission dialog. */
    fun respondToRequest(response: Response) {
        _pendingRequest.value = null
        pendingContinuation?.resume(response)
        pendingContinuation = null
    }

    /** Clear session grants AND denials (call when a session ends). */
    fun clearSessionGrants(sessionId: String) {
        sessionGrants.remove(sessionId)
        sessionDenials.remove(sessionId)
    }
}
