package com.leoyuan.leophoneagent.debug

import com.leoyuan.leophoneagent.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Test

class PowerEditionIsolationTest {
    @Test
    fun shizukuDebugSurfaceMatchesEdition() {
        val exposed = DebugMethodRegistry.methods.any { it.name == "debug.shizuku.exec" }
        assertEquals(BuildConfig.POWER_FEATURES_ENABLED, exposed)
    }

    @Test
    fun powerTxnBridgeMatchesEdition() {
        assertEquals(
            BuildConfig.POWER_FEATURES_ENABLED,
            com.leoyuan.leophoneagent.power.txn.PowerTxnBridge.available,
        )
    }
}
