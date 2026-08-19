package com.leoyuan.leophoneagent.relay

data class FleetMachineRow(
    val label: String,
    val machine: String,
    val online: Boolean,
    val server: String? = null,
    val version: String? = null,
    val isPreset: Boolean = false,
) {
    val isAndroidBody: Boolean
        get() = server == "minis"
}

object FleetListMerge {
    /** Presets stay as the "fill my 3 Macs" shortcut; live /machines rows follow. */
    fun displayMachines(
        live: List<RelayMachine>,
        presets: List<FleetPreset> = LeoFleetPresets,
    ): List<FleetMachineRow> {
        val byName = live.associateBy { it.name }
        val presetRows = presets.map { preset ->
            val found = byName[preset.machine]
            FleetMachineRow(
                label = preset.label,
                machine = preset.machine,
                online = found?.online == true,
                server = found?.server,
                version = found?.version,
                isPreset = true,
            )
        }
        val extras = live.filter { machine -> presets.none { it.machine == machine.name } }
            .map { machine ->
                FleetMachineRow(
                    label = machine.name,
                    machine = machine.name,
                    online = machine.online,
                    server = machine.server,
                    version = machine.version,
                    isPreset = false,
                )
            }
        return presetRows + extras
    }
}
