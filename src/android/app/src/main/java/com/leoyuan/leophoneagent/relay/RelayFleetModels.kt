package com.leoyuan.leophoneagent.relay

import kotlinx.serialization.Serializable

@Serializable
data class RelayFleetConfig(
    val relayApiBase: String = DEFAULT_RELAY_API_BASE,
    val accessKey: String = "",
    val machineName: String = "",
    val bodyEnabled: Boolean = false,
) {
    companion object {
        const val DEFAULT_RELAY_API_BASE =
            "https://mac-mini-cortex.tail23de22.ts.net/leoagent-relay/relay/api"
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

data class FleetPreset(val label: String, val machine: String)

val LeoFleetPresets = listOf(
    FleetPreset("MacBook Pro", "LeoyuandeMacBook-Pro-2"),
    FleetPreset("Mac mini · cortex", "LeodeMac-mini-2"),
    FleetPreset("Mac Studio", "LeoMac-Studio-2"),
)

class RelayException(message: String) : Exception(message)
