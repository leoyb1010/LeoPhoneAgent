package com.leoyuan.leophoneagent.ui.chat

// [T-android-split-chat] Small UI-state toggle methods extracted from
// ChatViewModel as extension functions (verbatim): tool-detail sheet,
// browser sheet, memory sheet, attachment list. The 4 backing state fields
// were flipped private->internal. No logic change.

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.compose.foundation.lazy.LazyListState
import com.leoyuan.leophoneagent.agent.Level
import com.leoyuan.leophoneagent.agent.ToolLoopDetector
import com.leoyuan.leophoneagent.browser.BrowserActionInput
import com.leoyuan.leophoneagent.browser.BrowserTabPool
import com.leoyuan.leophoneagent.data.db.MessageEntity
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Compress
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Lightbulb
import androidx.compose.material.icons.filled.Psychology
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Extension
import com.leoyuan.leophoneagent.data.BPETokenizer
import com.leoyuan.leophoneagent.data.ContextOffload
import com.leoyuan.leophoneagent.data.ContextPolicy
import com.leoyuan.leophoneagent.logging.AppLogger
import com.leoyuan.leophoneagent.data.FileMentionIndex
import com.leoyuan.leophoneagent.data.db.CompactMarkerEntity
import com.leoyuan.leophoneagent.data.model.AgentContentPart
import com.leoyuan.leophoneagent.data.model.AgentToolDefinition
import com.leoyuan.leophoneagent.data.model.LLMMessage
import com.leoyuan.leophoneagent.data.model.LLMModel
import com.leoyuan.leophoneagent.data.model.LLMStreamChunk
import com.leoyuan.leophoneagent.data.model.LLMUsage
import com.leoyuan.leophoneagent.data.model.ModelGroup
import com.leoyuan.leophoneagent.data.model.ThinkingLevel
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.data.repository.ChatRepository
import com.leoyuan.leophoneagent.data.repository.MemoryRepository
import com.leoyuan.leophoneagent.data.repository.ProviderRepository
import com.leoyuan.leophoneagent.provider.ImageBudget
import com.leoyuan.leophoneagent.provider.LLMProvider
import com.leoyuan.leophoneagent.provider.ProviderFactory
import com.leoyuan.leophoneagent.sandbox.ExecutionCoordinator
import com.leoyuan.leophoneagent.terminal.MinisOpenUrlBroker
import com.leoyuan.leophoneagent.terminal.MinisUrlMarker
import com.leoyuan.leophoneagent.tools.AgentTools
import com.leoyuan.leophoneagent.tools.FileEditTool
import com.leoyuan.leophoneagent.tools.FileReadTool
import com.leoyuan.leophoneagent.tools.FileWriteTool
import com.leoyuan.leophoneagent.tools.MemoryTools
import com.leoyuan.leophoneagent.tools.ReadImageTool
import com.leoyuan.leophoneagent.tools.ToolExecutionResult
import com.leoyuan.leophoneagent.offload.OffloadPermissionManager
import com.leoyuan.leophoneagent.service.SessionActivityTracker
import com.leoyuan.leophoneagent.service.SessionConcurrencyManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import org.json.JSONObject
import java.io.ByteArrayOutputStream

internal fun ChatViewModel.openToolDetail(toolBlockId: String) {
    _selectedToolDetailId.value = toolBlockId
}

internal fun ChatViewModel.closeToolDetail() {
    _selectedToolDetailId.value = null
}

internal fun ChatViewModel.toggleBrowserSheet() {
    val opening = !_showBrowserSheet.value
    if (opening) browserTabPool.ensureTabForUI()
    _showBrowserSheet.value = opening
}

internal fun ChatViewModel.dismissBrowserSheet() {
    _showBrowserSheet.value = false
}

/**
 * Open the session browser sheet, focused on the tab whose URL matches
 * [url]. If no pool tab currently has that URL, a new tab is created and
 * loaded. Used by the tool-call preview's globe button so the agent's
 * existing browser_use page is reused when available instead of spawning
 * a duplicate tab.
 */
internal fun ChatViewModel.openBrowserSheetForUrl(url: String) {
    if (url.isBlank()) {
        browserTabPool.ensureTabForUI()
    } else {
        browserTabPool.selectOrCreateTabForURL(url)
    }
    _showBrowserSheet.value = true
}

internal fun ChatViewModel.toggleMemorySheet() {
    _showMemorySheet.value = !_showMemorySheet.value
}

internal fun ChatViewModel.dismissMemorySheet() {
    _showMemorySheet.value = false
}

internal fun ChatViewModel.addAttachment(attachment: InputAttachment) {
    _attachments.value = _attachments.value + attachment
}

internal fun ChatViewModel.removeAttachment(id: String) {
    _attachments.value = _attachments.value.filter { it.id != id }
}

internal fun ChatViewModel.clearAttachments() {
    _attachments.value = emptyList()
}
