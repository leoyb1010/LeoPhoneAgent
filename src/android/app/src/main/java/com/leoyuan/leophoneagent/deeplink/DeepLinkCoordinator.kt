package com.leoyuan.leophoneagent.deeplink

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Holds pending deep-link side-effects that outlive a single navigation event.
 * Mirrors iOS DeepLinkCoordinator.
 */
object DeepLinkCoordinator {

    private val _pendingTreasuryCapture = MutableStateFlow(false)
    val pendingTreasuryCapture: StateFlow<Boolean> = _pendingTreasuryCapture.asStateFlow()

    fun requestTreasuryCapture() { _pendingTreasuryCapture.value = true }

    fun consumeTreasuryCapture(): Boolean {
        val current = _pendingTreasuryCapture.value
        _pendingTreasuryCapture.value = false
        return current
    }

    data class EnvVarCreate(val key: String, val value: String, val note: String)

    private val _pendingEnvVarCreate = MutableStateFlow<EnvVarCreate?>(null)
    val pendingEnvVarCreate: StateFlow<EnvVarCreate?> = _pendingEnvVarCreate.asStateFlow()

    fun setPendingEnvVarCreate(key: String, value: String, note: String = "") {
        _pendingEnvVarCreate.value = EnvVarCreate(key, value, note)
    }

    fun consumePendingEnvVarCreate(): EnvVarCreate? {
        val current = _pendingEnvVarCreate.value
        _pendingEnvVarCreate.value = null
        return current
    }

    /**
     * Optional `?tab=…` hint from `minis://settings/logs?tab=config-audit`.
     * The Logs screen reads this on appear to land on the right
     * segmented-control tab. Cleared by the screen after consumption.
     * Mirrors iOS DeepLinkCoordinator.pendingLogsTab.
     */
    private val _pendingLogsTab = MutableStateFlow<String?>(null)
    val pendingLogsTab: StateFlow<String?> = _pendingLogsTab.asStateFlow()

    fun setPendingLogsTab(tab: String?) { _pendingLogsTab.value = tab }
    fun consumePendingLogsTab(): String? {
        val current = _pendingLogsTab.value
        _pendingLogsTab.value = null
        return current
    }

    /**
     * Pending pinned-shortcut HTML preview: filesystem path + cached title.
     * MainActivity sets this on `minis://preview/html` deep link; ChatScreen
     * reads it on first composition and routes into WebPreviewFullscreen.
     */
    data class HtmlPreview(val sessionId: String, val resourcePath: String, val title: String)

    private val _pendingHtmlPreview = MutableStateFlow<HtmlPreview?>(null)
    val pendingHtmlPreview: StateFlow<HtmlPreview?> = _pendingHtmlPreview.asStateFlow()

    fun setPendingHtmlPreview(sessionId: String, resourcePath: String, title: String) {
        _pendingHtmlPreview.value = HtmlPreview(sessionId, resourcePath, title)
    }

    fun consumePendingHtmlPreview(): HtmlPreview? {
        val current = _pendingHtmlPreview.value
        _pendingHtmlPreview.value = null
        return current
    }

    /**
     * App-icon quick-action that a freshly-opened ChatScreen should auto-
     * trigger on first compose. Mirrors iOS `pendingChatAction` on
     * AIChatViewModel. Set by [com.leoyuan.leophoneagent.MainActivity] /
     * [com.leoyuan.leophoneagent.ui.navigation.AppNavigation] when the launch
     * intent carries `minis://action/voice_chat` or
     * `minis://action/camera_chat`; consumed exactly once by ChatScreen
     * so re-entering the same chat later doesn't fire the action again.
     */
    enum class ChatAction { START_VOICE, OPEN_CAMERA, RESUME }

    private val _pendingChatAction = MutableStateFlow<ChatAction?>(null)
    val pendingChatAction: StateFlow<ChatAction?> = _pendingChatAction.asStateFlow()

    fun setPendingChatAction(action: ChatAction) {
        _pendingChatAction.value = action
    }

    fun consumePendingChatAction(): ChatAction? {
        val current = _pendingChatAction.value
        _pendingChatAction.value = null
        return current
    }

    /**
     * System-assistant launch (ROLE_ASSISTANT / ACTION_ASSIST / VoiceInteraction).
     * ChatScreen consumes this once to seed the composer + optional screenshot.
     */
    data class AssistLaunch(val sourcePackage: String?, val screenshotPath: String?)

    private val _pendingAssist = MutableStateFlow<AssistLaunch?>(null)
    val pendingAssist: StateFlow<AssistLaunch?> = _pendingAssist.asStateFlow()

    fun setPendingAssist(sourcePackage: String?, screenshotPath: String?) {
        _pendingAssist.value = AssistLaunch(sourcePackage, screenshotPath)
    }

    fun setPendingAssist(launch: com.leoyuan.leophoneagent.assistant.AssistIntents.Launch) {
        setPendingAssist(launch.sourcePackage, launch.screenshotPath)
    }

    fun consumePendingAssist(): AssistLaunch? {
        val current = _pendingAssist.value
        _pendingAssist.value = null
        return current
    }
}
