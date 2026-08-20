package com.leoyuan.leophoneagent.sandbox.offload

import android.content.Intent
import android.content.pm.PackageManager

/**
 * Resolves installed launcher apps after the Android 11 package-visibility
 * change. The manifest declares both `QUERY_ALL_PACKAGES` (sideload personal
 * agent) and a `MAIN`+`LAUNCHER` `<queries>` entry so OEMs that ignore the
 * install-time permission can still see home-screen activities.
 */
object InstalledLauncherApps {

    const val LAUNCHER_ACTION: String = Intent.ACTION_MAIN
    const val LAUNCHER_CATEGORY: String = Intent.CATEGORY_LAUNCHER

    data class LauncherApp(
        val packageName: String,
        val label: String,
        val launchable: Boolean,
    )

    fun launcherQueryIntent(): Intent =
        Intent(LAUNCHER_ACTION).addCategory(LAUNCHER_CATEGORY)

    fun list(packageManager: PackageManager): List<LauncherApp> {
        val matches = packageManager.queryIntentActivities(launcherQueryIntent(), 0)
        return matches.mapNotNull { resolve ->
            val info = resolve.activityInfo ?: return@mapNotNull null
            val pkg = info.packageName ?: return@mapNotNull null
            val label = resolve.loadLabel(packageManager)?.toString()?.ifBlank { pkg } ?: pkg
            LauncherApp(
                packageName = pkg,
                label = label,
                launchable = launchableOf(
                    packageManager.getLaunchIntentForPackage(pkg) != null,
                ),
            )
        }.distinctBy { it.packageName }.sortedBy { it.label.lowercase() }
    }

    /** Launchable means a launch intent exists, not `ActivityInfo.exported`. */
    fun launchableOf(hasLaunchIntent: Boolean): Boolean = hasLaunchIntent

    fun resolveFromCatalog(apps: List<LauncherApp>, query: String): LauncherApp? {
        val q = query.trim()
        if (q.isEmpty()) return null
        apps.firstOrNull { it.packageName.equals(q, ignoreCase = false) }?.let { return it }
        apps.firstOrNull { it.packageName.equals(q, ignoreCase = true) }?.let { return it }
        return apps.firstOrNull { it.label.equals(q, ignoreCase = true) }
    }

    fun resolve(packageManager: PackageManager, query: String): LauncherApp? =
        resolveFromCatalog(list(packageManager), query)

    fun launchIntent(packageManager: PackageManager, packageName: String): Intent? {
        if (packageName.isBlank()) return null
        packageManager.getLaunchIntentForPackage(packageName)?.let { return it }
        val match = packageManager.queryIntentActivities(launcherQueryIntent(), 0)
            .firstOrNull { it.activityInfo?.packageName == packageName }
            ?: return null
        val activity = match.activityInfo ?: return null
        return Intent(LAUNCHER_ACTION)
            .addCategory(LAUNCHER_CATEGORY)
            .setClassName(activity.packageName, activity.name)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
