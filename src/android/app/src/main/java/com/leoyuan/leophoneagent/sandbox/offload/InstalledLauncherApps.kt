package com.leoyuan.leophoneagent.sandbox.offload

import android.content.Intent
import android.content.pm.PackageManager

/**
 * Resolves installed launcher apps after the Android 11 package-visibility
 * change. The manifest declares both `QUERY_ALL_PACKAGES` (sideload personal
 * agent) and a `MAIN`+`LAUNCHER` `<queries>` entry so OEMs that ignore the
 * install-time permission can still see home-screen activities.
 *
 * This is not a new LLM tool — [OpenOffloadHandler] uses it when an
 * `intent:` / `android-app:` URI names a package that `resolveActivity`
 * cannot see.
 */
object InstalledLauncherApps {

    const val LAUNCHER_ACTION: String = Intent.ACTION_MAIN
    const val LAUNCHER_CATEGORY: String = Intent.CATEGORY_LAUNCHER

    fun launcherQueryIntent(): Intent =
        Intent(LAUNCHER_ACTION).addCategory(LAUNCHER_CATEGORY)

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
