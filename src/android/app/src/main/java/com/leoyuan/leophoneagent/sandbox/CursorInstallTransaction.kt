package com.leoyuan.leophoneagent.sandbox

import android.content.Context
import java.io.File

/** Host-filesystem rollback around Cursor's non-atomic in-place version replacement. */
class CursorInstallTransaction private constructor(
    private val versionsDir: File,
    private val backupDir: File,
    private val hadBackup: Boolean,
) {
    fun commit() {
        File(versionsDir, READY_MARKER).writeText("ok")
        if (hadBackup) backupDir.deleteRecursively()
    }

    fun rollback() {
        if (!hadBackup) return
        versionsDir.deleteRecursively()
        check(backupDir.renameTo(versionsDir)) { "Could not restore the previous Cursor CLI version" }
    }

    companion object {
        fun begin(context: Context): CursorInstallTransaction {
            val rootfs = RootfsManager.getInstance(context.applicationContext).rootfsDir.canonicalFile
            return beginAt(rootfs)
        }

        internal fun beginAt(rootfsInput: File): CursorInstallTransaction {
            val rootfs = rootfsInput.canonicalFile
            val parent = File(rootfs, "root/.local/share/cursor-agent").canonicalFile
            check(parent.path.startsWith(rootfs.path + File.separator))
            parent.mkdirs()
            val versions = File(parent, "versions")
            val backup = File(parent, "versions.leophone-backup")

            // A completed update writes a readiness marker before deleting its
            // backup. If backup cleanup alone was interrupted, the marked new
            // tree is authoritative and the stale backup can be discarded.
            if (backup.exists() && File(versions, READY_MARKER).isFile) {
                backup.deleteRecursively()
            }

            // A killed previous update leaves the good version in backup and a
            // partial new directory at versions. Keep the good backup and clear
            // only the partial tree before retrying.
            if (backup.exists()) {
                versions.deleteRecursively()
                versions.mkdirs()
                return CursorInstallTransaction(versions, backup, hadBackup = true)
            }

            val hadCurrent = versions.exists() && versions.listFiles()?.isNotEmpty() == true
            if (hadCurrent) {
                check(versions.renameTo(backup)) { "Could not stage the current Cursor CLI for rollback" }
            }
            versions.mkdirs()
            return CursorInstallTransaction(versions, backup, hadBackup = hadCurrent)
        }

        private const val READY_MARKER = ".leophone-ready"
    }
}
