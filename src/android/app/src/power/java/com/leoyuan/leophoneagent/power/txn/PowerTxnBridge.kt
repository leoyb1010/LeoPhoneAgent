package com.leoyuan.leophoneagent.power.txn

import android.content.Context

object PowerTxnBridge {
    const val available: Boolean = true

    fun actor(context: Context, sessionId: String): PackageActor =
        ShizukuPackageActor(context.applicationContext, sessionId)

    fun rules(context: Context): List<com.leoyuan.leophoneagent.power.rules.AppRule> =
        com.leoyuan.leophoneagent.power.rules.RulesHotUpdate.loadActive(
            java.io.File(context.filesDir, "power-rules"),
        )
}
