package com.leoyuan.leophoneagent.service

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Home-list counters for 进行中 / 审批. Running comes from
 * [SessionActivityTracker]; pending approvals are published by the fleet
 * screen so the session list can show a count without merging remote
 * sessions into Room (that merge is T6).
 */
object SessionTaskStatus {
    private val _pendingApprovals = MutableStateFlow(0)
    val pendingApprovals: StateFlow<Int> = _pendingApprovals.asStateFlow()

    fun setPendingApprovals(count: Int) {
        _pendingApprovals.value = count.coerceAtLeast(0)
    }
}
