package com.leoyuan.leophoneagent.ui.settings

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.leoyuan.leophoneagent.sandbox.CliStatusReport
import com.leoyuan.leophoneagent.sandbox.CliAuthState
import com.leoyuan.leophoneagent.sandbox.CliToolCatalog
import com.leoyuan.leophoneagent.sandbox.CliToolId
import com.leoyuan.leophoneagent.sandbox.CursorInstallTransaction
import com.leoyuan.leophoneagent.sandbox.ExecutionCoordinator
import com.leoyuan.leophoneagent.sandbox.RootfsManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class CliToolStatus(
    val installed: Boolean = false,
    val version: String? = null,
    val authState: CliAuthState = CliAuthState.UNAVAILABLE,
    val authDetail: String? = null,
)

/**
 * [T-cli-result-sealed] Success and failure used to share one string field
 * (`resultMessage`) whose meaning flipped on a boolean — success carried the
 * display name, failure carried raw shell output. Model the outcome instead.
 */
sealed interface CliOperationResult {
    val toolId: CliToolId

    data class Success(override val toolId: CliToolId) : CliOperationResult
    data class Failure(
        override val toolId: CliToolId,
        /** Full captured log so the user can read/copy the real error. */
        val log: String,
        val retryable: Boolean = true,
    ) : CliOperationResult

    data class Uninstalled(override val toolId: CliToolId) : CliOperationResult
}

data class CliToolsUiState(
    val rootfsReady: Boolean = false,
    val refreshing: Boolean = false,
    val busyTool: CliToolId? = null,
    /** true while the busy operation is an uninstall (drives dialog copy). */
    val busyUninstalling: Boolean = false,
    val progressLine: String? = null,
    /** Rolling install log, capped at [CliToolsViewModel.LOG_CAP] lines. */
    val progressLog: List<String> = emptyList(),
    val result: CliOperationResult? = null,
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
                result = null,
            )
            if (!rootfsReady) return@launch

            try {
                // [T-cli-status-single-pass] One proot round trip for all four
                // tools instead of four serial spawns.
                val probe = ExecutionCoordinator.execute(
                    sessionId = SESSION_ID,
                    command = CliToolCatalog.combinedStatusCommand(),
                    timeout = STATUS_TIMEOUT_MS,
                )
                val parsed = CliStatusReport.parse(probe.output)
                val statuses = CliToolId.entries.associateWith { id ->
                    val entry = parsed.getValue(id)
                    CliToolStatus(
                        installed = entry.installed,
                        version = entry.version,
                        authState = entry.authState,
                        authDetail = entry.authDetail,
                    )
                }
                _uiState.value = _uiState.value.copy(refreshing = false, statuses = statuses)
            } catch (_: CancellationException) {
                _uiState.value = _uiState.value.copy(refreshing = false)
            } catch (error: Throwable) {
                _uiState.value = _uiState.value.copy(refreshing = false)
                // A failed probe keeps the previous statuses; no fake reds.
                android.util.Log.w(TAG, "status probe failed: ${error.message}")
            }
        }
    }

    fun installOrUpdate(context: Context, id: CliToolId) {
        runExclusive(context, id, uninstall = false)
    }

    /** [T-cli-uninstall] Launcher binary only; login/config survive. */
    fun uninstall(context: Context, id: CliToolId) {
        runExclusive(context, id, uninstall = true)
    }

    private fun runExclusive(context: Context, id: CliToolId, uninstall: Boolean) {
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
                busyUninstalling = uninstall,
                progressLine = null,
                progressLog = emptyList(),
                result = null,
            )
            var cursorTransaction: CursorInstallTransaction? = null
            try {
                cursorTransaction = if (!uninstall && id == CliToolId.CURSOR) {
                    CursorInstallTransaction.begin(app)
                } else {
                    null
                }
                val result = ExecutionCoordinator.execute(
                    sessionId = SESSION_ID,
                    command = if (uninstall) tool.uninstallCommand() else tool.installCommand(),
                    timeout = if (uninstall) STATUS_TIMEOUT_MS else installTimeoutFor(id),
                    lineCallback = { line ->
                        val state = _uiState.value
                        _uiState.value = state.copy(
                            progressLine = line.takeLast(180),
                            progressLog = (state.progressLog + line).takeLast(LOG_CAP),
                        )
                    },
                )
                val ok = result.exitCode == 0
                if (ok) cursorTransaction?.commit() else cursorTransaction?.rollback()
                val statuses = _uiState.value.statuses.toMutableMap()
                if (ok) {
                    statuses[id] = if (uninstall) {
                        CliToolStatus()
                    } else {
                        CliToolStatus(
                            installed = true,
                            version = result.output.lineSequence()
                                .lastOrNull { it.isNotBlank() }?.trim()?.take(120),
                        )
                    }
                }
                _uiState.value = _uiState.value.copy(
                    busyTool = null,
                    busyUninstalling = false,
                    progressLine = null,
                    statuses = statuses,
                    result = when {
                        ok && uninstall -> CliOperationResult.Uninstalled(id)
                        ok -> CliOperationResult.Success(id)
                        else -> CliOperationResult.Failure(
                            toolId = id,
                            log = failureLog(_uiState.value.progressLog, result.output),
                            retryable = !uninstall,
                        )
                    },
                )
            } catch (_: CancellationException) {
                runCatching { cursorTransaction?.rollback() }
                _uiState.value = _uiState.value.copy(
                    busyTool = null, busyUninstalling = false, progressLine = null,
                )
            } catch (error: Throwable) {
                runCatching { cursorTransaction?.rollback() }
                _uiState.value = _uiState.value.copy(
                    busyTool = null,
                    busyUninstalling = false,
                    progressLine = null,
                    result = CliOperationResult.Failure(
                        toolId = id,
                        log = error.message?.take(2000) ?: error.javaClass.simpleName,
                        retryable = !uninstall,
                    ),
                )
            }
        }
    }

    fun cancel() {
        ExecutionCoordinator.stopCurrentCommand(SESSION_ID)
        operation?.cancel()
        _uiState.value = _uiState.value.copy(
            busyTool = null, busyUninstalling = false, progressLine = null,
        )
    }

    fun clearResult() {
        _uiState.value = _uiState.value.copy(result = null)
    }

    override fun onCleared() {
        ExecutionCoordinator.sessionDidTerminate(SESSION_ID)
        super.onCleared()
    }

    companion object {
        internal const val SESSION_ID = "cli-tools-manager"
        private const val TAG = "CliToolsViewModel"
        private const val STATUS_TIMEOUT_MS = 30_000L
        internal const val LOG_CAP = 400

        /**
         * [T-cli-timeout-tiers] Cursor rebuilds native modules from source on
         *低端机 this can far exceed the flat 10-minute ceiling that fits the
         * other three script installers.
         */
        internal fun installTimeoutFor(id: CliToolId): Long = when (id) {
            CliToolId.CURSOR -> 20 * 60_000L
            else -> 10 * 60_000L
        }

        /**
         * Failure text shown/copied by the UI: prefer the rolling log (it has
         * the installer's own stderr); fall back to raw command output.
         */
        internal fun failureLog(log: List<String>, rawOutput: String): String {
            val joined = log.joinToString("\n").trim()
            val base = joined.ifEmpty { rawOutput.trim() }
            return base.takeLast(8000)
        }
    }
}
