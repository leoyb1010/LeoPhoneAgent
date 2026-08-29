package com.leoyuan.leophoneagent.accessibility

import android.content.Context
import android.provider.Settings
import com.leoyuan.leophoneagent.logging.AppLogger
import com.leoyuan.leophoneagent.offload.ShizukuManager
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull

/** Detects force-stop revocation and restores only this service when Shizuku is ready. */
object AccessibilityRecoveryManager {
    private const val TAG = "A11yRecovery"
    private const val PREFS = "a11y_recovery"
    private const val KEY_EVER_GRANTED = "ever_granted"

    fun markGranted(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_EVER_GRANTED, true).apply()
    }

    fun hasEverBeenGranted(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getBoolean(KEY_EVER_GRANTED, false)

    fun isRevokedIn(enabledValue: String?, pkg: String, serviceClass: String): Boolean {
        if (enabledValue.isNullOrBlank()) return true
        val full = "$pkg/$serviceClass"
        val short = "$pkg/.${serviceClass.removePrefix("$pkg.")}"
        return enabledValue.split(':').none {
            it.trim().equals(full, ignoreCase = true) || it.trim().equals(short, ignoreCase = true)
        }
    }

    fun isGrantRevoked(context: Context): Boolean {
        if (!hasEverBeenGranted(context)) return false
        val enabled = runCatching {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
        }.getOrNull() ?: return true
        return isRevokedIn(enabled, context.packageName, MinisAccessibilityService::class.java.name)
    }

    suspend fun ensureUsable(context: Context): Boolean {
        if (MinisAccessibilityService.getInstance() != null) return true
        if (!isGrantRevoked(context) || !ShizukuManager.isReady()) return false
        val target = "${context.packageName}/${MinisAccessibilityService::class.java.name}"
        val existing = runCatching {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES)
                ?.split(':')?.map(String::trim)?.filter(String::isNotEmpty).orEmpty()
        }.getOrDefault(emptyList())
        val merged = (existing + target).distinct().joinToString(":")
        val services = ShizukuManager.runProcess(arrayOf(
            "settings", "put", "secure", Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, merged,
        ))
        val enabled = ShizukuManager.runProcess(arrayOf(
            "settings", "put", "secure", Settings.Secure.ACCESSIBILITY_ENABLED, "1",
        ))
        if (services.exitCode != 0 || enabled.exitCode != 0) {
            AppLogger.warning(TAG, "repair failed: services=${services.exitCode} enabled=${enabled.exitCode}")
            return false
        }
        val rebound = withTimeoutOrNull(5_000L) {
            while (MinisAccessibilityService.getInstance() == null) delay(250L)
            true
        } == true
        AppLogger.info(TAG, "grant restored without overwriting peer services; rebound=$rebound")
        return rebound
    }
}
