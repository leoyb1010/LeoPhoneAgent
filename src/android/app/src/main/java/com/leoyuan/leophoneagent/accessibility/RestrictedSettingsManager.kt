package com.leoyuan.leophoneagent.accessibility

import android.content.Context
import android.content.pm.PackageInstaller
import android.os.Build
import com.leoyuan.leophoneagent.logging.AppLogger
import com.leoyuan.leophoneagent.offload.ShizukuManager

/** Detects Android's sideloaded-app restricted-settings gate for Accessibility. */
object RestrictedSettingsManager {
    private const val TAG = "RestrictedSettings"

    @Volatile private var cleared = false

    fun isRestricted(context: Context): Boolean {
        if (cleared || Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false
        return runCatching {
            val source = context.packageManager
                .getInstallSourceInfo(context.packageName)
                .packageSource
            isRestrictedSource(source)
        }.onFailure {
            AppLogger.info(TAG, "install-source probe unavailable: ${it.javaClass.simpleName}")
        }.getOrDefault(false)
    }

    @android.annotation.TargetApi(Build.VERSION_CODES.TIRAMISU)
    internal fun isRestrictedSource(packageSource: Int): Boolean =
        packageSource == PackageInstaller.PACKAGE_SOURCE_LOCAL_FILE ||
            packageSource == PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE

    /** Clears the app-op through an already-authorized Shizuku session and reads it back. */
    suspend fun clearWithShizuku(context: Context): Boolean {
        if (!ShizukuManager.isReady()) return false
        val set = ShizukuManager.runProcess(
            arrayOf("appops", "set", context.packageName, "ACCESS_RESTRICTED_SETTINGS", "allow"),
        )
        if (set.exitCode != 0) {
            AppLogger.warning(TAG, "appops set failed: exit=${set.exitCode}")
            return false
        }
        val get = ShizukuManager.runProcess(
            arrayOf("appops", "get", context.packageName, "ACCESS_RESTRICTED_SETTINGS"),
        )
        val ok = get.exitCode == 0 && get.combined.contains("allow", ignoreCase = true)
        if (ok) cleared = true
        AppLogger.info(TAG, "restricted settings clear verified=$ok")
        return ok
    }
}
