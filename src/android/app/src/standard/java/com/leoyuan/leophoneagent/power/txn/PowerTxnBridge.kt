package com.leoyuan.leophoneagent.power.txn

import android.content.Context

object PowerTxnBridge {
    const val available: Boolean = false

    fun actor(context: Context, sessionId: String): PackageActor = NoopPackageActor

    fun rules(context: Context): List<com.leoyuan.leophoneagent.power.rules.AppRule> = emptyList()
}
