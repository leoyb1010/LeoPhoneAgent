package com.leoyuan.leophoneagent.util

/** Retry the same encrypted store; initialization failure never authorizes reset. */
internal object EncryptedPrefsRecovery {
    fun <T : Any> open(create: () -> T, failed: (Exception) -> Unit): T? {
        repeat(2) {
            try { return create() } catch (error: Exception) { failed(error) }
        }
        return null
    }
}
