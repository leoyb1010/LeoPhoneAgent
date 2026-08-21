package com.leoyuan.leophoneagent.sandbox

import java.io.File
import kotlin.io.path.createTempDirectory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CursorInstallTransactionTest {
    @Test
    fun failedUpdateRestoresPreviousVersion() {
        withRootfs { root ->
            val versions = versions(root)
            File(versions, "old/cursor-agent").apply { parentFile!!.mkdirs(); writeText("old") }
            val tx = CursorInstallTransaction.beginAt(root)
            File(versions, "new/cursor-agent").apply { parentFile!!.mkdirs(); writeText("partial") }

            tx.rollback()

            assertEquals("old", File(versions, "old/cursor-agent").readText())
            assertFalse(File(versions, "new").exists())
        }
    }

    @Test
    fun successfulUpdateMarksNewVersionAndRemovesBackup() {
        withRootfs { root ->
            val versions = versions(root)
            File(versions, "old/cursor-agent").apply { parentFile!!.mkdirs(); writeText("old") }
            val tx = CursorInstallTransaction.beginAt(root)
            File(versions, "new/cursor-agent").apply { parentFile!!.mkdirs(); writeText("new") }

            tx.commit()

            assertTrue(File(versions, ".leophone-ready").isFile)
            assertFalse(File(versions.parentFile, "versions.leophone-backup").exists())
        }
    }

    private fun versions(root: File) = File(root, "root/.local/share/cursor-agent/versions")

    private fun withRootfs(block: (File) -> Unit) {
        val root = createTempDirectory("cursor-tx").toFile()
        try { block(root) } finally { root.deleteRecursively() }
    }
}
