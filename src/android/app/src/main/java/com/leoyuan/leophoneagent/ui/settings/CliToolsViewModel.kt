package com.leoyuan.leophoneagent.ui.settings

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.leoyuan.leophoneagent.sandbox.CliToolCatalog
import com.leoyuan.leophoneagent.sandbox.CliToolId
import com.leoyuan.leophoneagent.sandbox.ExecutionCoordinator
import com.leoyuan.leophoneagent.sandbox.RootfsManager
import com.leoyuan.leophoneagent.sandbox.CursorInstallTransaction
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class CliToolStatus(
    val installed: Boolean = false,
    val version: String? = null,
)

data class CliToolsUiState(
    val rootfsReady: Boolean = false,
    val refreshing: Boolean = false,
    val busyTool: CliToolId? = null,
    val progressLine: String? = null,
    val resultMessage: String? = null,
    val operationSucceeded: Boolean = false,
    val statuses: Map<CliToolId, CliToolStatus> = CliToolId.entries.associateWith { CliToolStatus() },
)

class CliToolsViewModel : ViewModel() {
    private val _uiState = MutableStateFlow(CliToolsUiState())
    val uiState: StateFlow<CliToolsUiState> = _uiState.asStateFlow()
    private var operation: Job? = null

    fun refresh(context: Context) {
        if (_uiState.value.busyTool != null) return
        operation?.cancel()
        val app = context.applicationContext
        operation = viewModelScope.launch {
            val rootfsReady = RootfsManager.getInstance(app).isInstalled
            _uiState.value = _uiState.value.copy(
                rootfsReady = rootfsReady,
                refreshing = rootfsReady,
                resultMessage = null,
            )
            if (!rootfsReady) return@launch

            try {
                val statuses = linkedMapOf<CliToolId, CliToolStatus>()
                CliToolCatalog.tools.forEach { tool ->
                    val result = ExecutionCoordinator.execute(
                        sessionId = SESSION_ID,
                        command = tool.statusCommand(),
                        timeout = STATUS_TIMEOUT_MS,
                    )
                    statuses[tool.id] = if (result.exitCode == 0) {
                        CliToolStatus(installed = true, version = result.output.lineSequence().firstOrNull()?.take(120))
                    } else {
                        CliToolStatus()
                    }
                }
                _uiState.value = _uiState.value.copy(refreshing = false, statuses = statuses)
            } catch (_: CancellationException) {
                _uiState.value = _uiState.value.copy(refreshing = false)
            } catch (error: Throwable) {
                _uiState.value = _uiState.value.copy(
                    refreshing = false,
                    operationSucceeded = false,
                    resultMessage = error.message?.take(300),
                )
            }
        }
    }

    fun installOrUpdate(context: Context, id: CliToolId) {
        if (_uiState.value.busyTool != null) return
        val app = context.applicationContext
        operation?.cancel()
        operation = viewModelScope.launch {
            if (!RootfsManager.getInstance(app).isInstalled) {
                _uiState.value = _uiState.value.copy(rootfsReady = false)
                return@launch
            }
            val tool = CliToolCatalog.get(id)
            _uiState.value = _uiState.value.copy(
                busyTool = id,
                progressLine = null,
                resultMessage = null,
            )
            var cursorTransaction: CursorInstallTransaction? = null
            try {
                cursorTransaction = if (id == CliToolId.CURSOR) {
                    CursorInstallTransaction.begin(app)
                } else {
                    null
                }
                val result = ExecutionCoordinator.execute(
                    sessionId = SESSION_ID,
                    command = tool.installCommand(),
                    timeout = INSTALL_TIMEOUT_MS,
                    lineCallback = { line ->
                        _uiState.value = _uiState.value.copy(progressLine = line.takeLast(180))
                    },
                )
                val ok = result.exitCode == 0
                if (ok) cursorTransaction?.commit() else cursorTransaction?.rollback()
                val version = result.output.lineSequence().lastOrNull()?.take(120)
                val statuses = _uiState.value.statuses.toMutableMap()
                if (ok) statuses[id] = CliToolStatus(installed = true, version = version)
                _uiState.value = _uiState.value.copy(
                    busyTool = null,
                    progressLine = null,
                    statuses = statuses,
                    operationSucceeded = ok,
                    resultMessage = if (ok) tool.displayName else result.output.takeLast(500),
                )
            } catch (_: CancellationException) {
                runCatching { cursorTransaction?.rollback() }
                _uiState.value = _uiState.value.copy(busyTool = null, progressLine = null)
            } catch (error: Throwable) {
                runCatching { cursorTransaction?.rollback() }
                _uiState.value = _uiState.value.copy(
                    busyTool = null,
                    progressLine = null,
                    operationSucceeded = false,
                    resultMessage = error.message?.take(300),
                )
            }
        }
    }

    fun cancel() {
        ExecutionCoordinator.stopCurrentCommand(SESSION_ID)
        operation?.cancel()
        _uiState.value = _uiState.value.copy(busyTool = null, progressLine = null)
    }

    fun clearResult() {
        _uiState.value = _uiState.value.copy(resultMessage = null)
    }

    override fun onCleared() {
        ExecutionCoordinator.sessionDidTerminate(SESSION_ID)
        super.onCleared()
    }

    companion object {
        internal const val SESSION_ID = "cli-tools-manager"
        private const val STATUS_TIMEOUT_MS = 30_000L
        private const val INSTALL_TIMEOUT_MS = 10 * 60_000L
    }
}
