package com.leoyuan.leophoneagent.sandbox

import android.content.Context
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/** Non-secret CLI configuration generated from a LeoPhoneAgent provider. */
data class CliManagedConfig(
    val guestPath: String,
    val content: String,
    val arguments: List<String> = emptyList(),
    val preserveExisting: Boolean = false,
)

object CliManagedConfigWriter {
    private const val ROOT = "/root/.leophone-cli/"

    /**
     * Writes only endpoint/model/protocol metadata. Provider credentials stay
     * in EncryptedSharedPreferences and are injected transiently per command.
     */
    fun prepare(context: Context, config: CliManagedConfig?): Result<Unit> = runCatching {
        if (config == null) return@runCatching
        require(isAllowedGuestPath(config.guestPath))
        require(config.content.length <= 64 * 1024 && !config.content.contains('\u0000'))
        val rootfs = RootfsManager.getInstance(context.applicationContext)
        require(rootfs.isInstalled) { "Linux runtime is not installed" }
        val relative = config.guestPath.removePrefix("/")
        val target = File(rootfs.rootfsDir, relative)
        val canonicalRoot = rootfs.rootfsDir.canonicalFile
        val canonicalParent = target.parentFile?.apply { mkdirs() }?.canonicalFile
            ?: error("Missing config parent")
        require(canonicalParent.path.startsWith(canonicalRoot.path + File.separator))
        require(target.canonicalFile.path.startsWith(canonicalRoot.path + File.separator))
        if (config.preserveExisting && target.isFile) return@runCatching
        val temp = File(canonicalParent, ".${target.name}.tmp")
        temp.writeText(config.content, Charsets.UTF_8)
        temp.setReadable(false, false)
        temp.setWritable(false, false)
        temp.setReadable(true, true)
        temp.setWritable(true, true)
        runCatching {
            Files.move(
                temp.toPath(),
                target.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE,
            )
        }.getOrElse {
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }

    internal fun isAllowedGuestPath(path: String): Boolean =
        path.startsWith(ROOT) &&
            path.length <= 500 &&
            path.none(Char::isISOControl) &&
            path.split('/').none { it == ".." }
}
