package com.leoyuan.leophoneagent.power.txn

import android.content.Context
import com.leoyuan.leophoneagent.offload.OffloadPermissionManager
import com.leoyuan.leophoneagent.offload.ShizukuManager
import com.leoyuan.leophoneagent.sandbox.NativeOffloadServer
import kotlinx.coroutines.runBlocking

/**
 * Power-only privileged actor. Standard APK must not contain this class.
 * Gates stay on [OffloadPermissionManager] + Shizuku READY; pm verbs reuse
 * the same argv as `android-shizuku-cli` after the chat Confirm phase.
 */
class ShizukuPackageActor(
    private val context: Context,
    private val sessionId: String,
) : PackageActor {

    override fun capability(): Capability {
        val allowed = runBlocking {
            OffloadPermissionManager.checkPermission(
                toolName = "shizuku_cli",
                toolTitle = "android-shizuku-cli",
                sessionId = sessionId,
            )
        }
        if (!allowed) return Capability.Denied
        ShizukuManager.refresh()
        return when (ShizukuManager.snapshot.value.state) {
            ShizukuManager.State.NOT_INSTALLED, ShizukuManager.State.NOT_RUNNING -> Capability.ServiceDown
            ShizukuManager.State.NEED_PERMISSION -> Capability.NeedGrant
            ShizukuManager.State.READY -> Capability.Ready
        }
    }

    override fun listApps(): List<InstalledApp> {
        val r = ShizukuManager.runProcess(arrayOf("pm", "list", "packages", "-3"))
        val pm = context.packageManager
        return r.stdout.lineSequence()
            .map { it.removePrefix("package:").trim() }
            .filter { it.isNotBlank() }
            .map { pkg ->
                val label = runCatching {
                    pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
                }.getOrDefault(pkg)
                InstalledApp(pkg, label)
            }
            .toList()
    }

    override fun enabled(pkg: String): Boolean? {
        val r = ShizukuManager.runProcess(arrayOf("pm", "list", "packages", "-d", pkg))
        if (r.exitCode != 0) return null
        val disabled = r.stdout.lineSequence().any { it.removePrefix("package:").trim() == pkg }
        return !disabled
    }

    override fun confirm(title: String, body: String): Boolean = runBlocking {
        OffloadPermissionManager.checkPermission(
            toolName = "shizuku_dangerous",
            toolTitle = title,
            sessionId = sessionId,
            description = body,
            singleUseOnly = true,
        )
    }

    override fun freeze(pkg: String) = pm("disable-user", pkg)
    override fun unfreeze(pkg: String) = pm("enable", pkg)
    override fun uninstall(pkg: String) = pm("uninstall", pkg)
    override fun clear(pkg: String) = pm("clear", pkg)

    override fun grant(pkg: String, permission: String) =
        pmResult(ShizukuManager.runProcess(arrayOf("pm", "grant", pkg, permission)))

    override fun revoke(pkg: String, permission: String) =
        pmResult(ShizukuManager.runProcess(arrayOf("pm", "revoke", pkg, permission)))

    override fun install(apk: String) =
        pmResult(ShizukuManager.runProcess(arrayOf("pm", "install", "-r", apk), timeoutMs = 60_000))

    override fun fingerprint(): String? {
        val dump = NativeOffloadServer.invoke("android-a11y-cli", listOf("ui", "dump"), sessionId)
        if (dump.exitCode != 0) return null
        return dump.output.hashCode().toString()
    }

    private fun pm(verb: String, pkg: String) =
        pmResult(ShizukuManager.runProcess(arrayOf("pm", verb, pkg)))

    private fun pmResult(r: ShizukuManager.ProcessResult): ActorResult {
        val ok = r.exitCode == 0 && !r.combined.contains("Error", ignoreCase = true)
        return ActorResult(ok, r.combined.trim())
    }
}
