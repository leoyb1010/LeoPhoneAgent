package com.leoyuan.leophoneagent.service

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

data class RemoteSessionRow(
    val machine: String,
    val sessionId: String,
    val title: String,
    val status: String,
    val waitingApproval: Boolean,
)

/**
 * Home-list counters and remote rows. Running comes from
 * [SessionActivityTracker]; pending approvals and live remote sessions are
 * published by the fleet screen so they can sit in the local list.
 */
object SessionTaskStatus {
    private val _pendingApprovals = MutableStateFlow(0)
    val pendingApprovals: StateFlow<Int> = _pendingApprovals.asStateFlow()

    private val _remoteSessions = MutableStateFlow<List<RemoteSessionRow>>(emptyList())
    val remoteSessions: StateFlow<List<RemoteSessionRow>> = _remoteSessions.asStateFlow()

    private val _cardsEnabled = MutableStateFlow(true)
    val cardsEnabled: StateFlow<Boolean> = _cardsEnabled.asStateFlow()

    private val _torchOn = MutableStateFlow(false)
    val torchOn: StateFlow<Boolean> = _torchOn.asStateFlow()

    private val _lastTodo = MutableStateFlow<String?>(null)
    val lastTodo: StateFlow<String?> = _lastTodo.asStateFlow()

    fun setPendingApprovals(count: Int) {
        _pendingApprovals.value = count.coerceAtLeast(0)
    }

    fun setRemoteSessions(rows: List<RemoteSessionRow>) {
        _remoteSessions.value = rows
    }

    fun setCardsEnabled(on: Boolean) {
        _cardsEnabled.value = on
    }

    fun setTorchOn(on: Boolean) {
        _torchOn.value = on
    }

    fun setLastTodo(title: String) {
        _lastTodo.value = title
    }
}
