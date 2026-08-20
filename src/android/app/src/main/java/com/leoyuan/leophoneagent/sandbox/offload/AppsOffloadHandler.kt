package com.leoyuan.leophoneagent.sandbox.offload

import android.content.Context
import com.leoyuan.leophoneagent.sandbox.NativeOffloadHandler
import com.leoyuan.leophoneagent.sandbox.NativeOffloadRequest
import com.leoyuan.leophoneagent.sandbox.NativeOffloadResult
import org.json.JSONArray
import org.json.JSONObject

/**
 * android-apps — list launchable home-screen apps using QUERY_ALL_PACKAGES
 * plus the MAIN+LAUNCHER `<queries>` fallback.
 */
class AppsOffloadHandler(private val context: Context) : NativeOffloadHandler {
    override fun handle(request: NativeOffloadRequest): NativeOffloadResult {
        val args = OffloadArgs(request.argv.drop(1))
        if (args.hasFlag("h", "help")) return NativeOffloadResult(0, HELP)
        OffloadGate.enforce("apps", "android-apps", args, request)?.let { return it }
        val filter = args.positional.firstOrNull()?.trim().orEmpty()
        val apps = InstalledLauncherApps.list(context.packageManager)
            .filter { app ->
                filter.isEmpty() ||
                    app.packageName.contains(filter, ignoreCase = true) ||
                    app.label.contains(filter, ignoreCase = true)
            }
        val arr = JSONArray()
        for (app in apps) {
            arr.put(
                JSONObject()
                    .put("package", app.packageName)
                    .put("label", app.label)
                    .put("launchable", app.launchable),
            )
        }
        val body = JSONObject()
            .put("count", apps.size)
            .put("apps", arr)
            .toString(2)
        return NativeOffloadResult(0, OffloadOutput.formatBody(body, args) + "\n")
    }

    companion object {
        private const val HELP = """android-apps — list installed launcher apps

Usage:
  android-apps              JSON list of {package, label, launchable}
  android-apps <filter>     Same list, filtered by package or label
  android-apps --help
"""
    }
}
