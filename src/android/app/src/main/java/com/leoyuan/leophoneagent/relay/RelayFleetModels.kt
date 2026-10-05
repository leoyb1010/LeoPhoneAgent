package com.leoyuan.leophoneagent.relay

import com.leoyuan.leophoneagent.BuildConfig
import kotlinx.serialization.Serializable

@Serializable
data class RelayFleetConfig(
    val relayApiBase: String = DEFAULT_RELAY_API_BASE,
    val accessKey: String = "",
    val machineName: String = "",
    val bodyEnabled: Boolean = false,
) {
    /** False when neither the user nor the local build configured a relay endpoint. */
    val isRelayConfigured: Boolean get() = relayApiBase.isNotBlank()

    companion object {
        /** Injected from git-ignored local config (`leo.relayApiRoot`); empty in the public repo. */
        val DEFAULT_RELAY_API_BASE: String = BuildConfig.LEO_RELAY_API_ROOT
        const val NOT_CONFIGURED_MESSAGE = "未配置中继地址"
    }
}

data class RelayMachine(
    val name: String,
    val online: Boolean,
    val connectedAt: Double? = null,
    val server: String? = null,
    val version: String? = null,
)

data class RelaySession(
    val id: String,
    val harness: String,
    val status: String,
    val cwd: String? = null,
    val lastEvent: String? = null,
    val windowLabel: String? = null,
    /** Approvals the machine still waits on, from the session list. */
    val pendingApprovalIds: Set<String> = emptySet(),
) {
    val isTerminal: Boolean get() = status in setOf("completed", "failed", "cancelled")
}

data class RelayApproval(
    val machine: String,
    val sessionId: String,
    val approvalId: String,
    val command: String?,
    val description: String?,
    val choices: List<String>,
    val seq: Int,
)

data class RelayEventBatch(
    val approvals: List<RelayApproval>,
    val now: Double,
)

data class RelayHarnessEvent(
    val machine: String,
    val sessionId: String,
    val seq: Int,
    val event: String,
    val delta: String? = null,
    val output: String? = null,
    val approvalId: String? = null,
    val command: String? = null,
    val description: String? = null,
    val choices: List<String> = emptyList(),
)

data class RelayJoinToken(val token: String, val exp: Long? = null)

data class RelayJoinResult(val accessKey: String, val machine: String)

data class FleetPreset(val label: String, val machine: String)

/** Machine shortcuts injected from local config (`leo.fleetPresets`); empty in the public repo. */
val LeoFleetPresets: List<FleetPreset> = parseFleetPresets(BuildConfig.LEO_FLEET_PRESETS)

/** Parses `Label|machine;Label|machine`; malformed entries are skipped. */
internal fun parseFleetPresets(raw: String): List<FleetPreset> =
    raw.split(';').mapNotNull { entry ->
        val parts = entry.split('|', limit = 2)
        val label = parts.getOrNull(0)?.trim().orEmpty()
        val machine = parts.getOrNull(1)?.trim().orEmpty()
        if (label.isEmpty() || machine.isEmpty()) null else FleetPreset(label, machine)
    }

/** [status] is the HTTP status when the relay or the machine answered with an error. */
open class RelayException(message: String, val status: Int? = null) : Exception(message)

class RelayEventsExpiredException(val minAfter: Int) :
    RelayException("远程事件已过期，将从可用水位 $minAfter 重新同步")
