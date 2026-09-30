package com.leoyuan.leophoneagent.sandbox

import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files

class GuestPathPolicyTest {
    @Test fun normalizeBeforeMountSelection() {
        assertEquals("/var/minis/mounts/locked/file", GuestPathPolicy.normalize("/var/minis/workspace/../mounts/locked/file"))
        assertEquals("/var/minis/workspace/a", GuestPathPolicy.normalize("//var/minis/./workspace//a"))
        assertEquals("/etc/os-release", GuestPathPolicy.normalize("etc/os-release"))
        assertNull(GuestPathPolicy.normalize("/../../outside"))
        assertNull(GuestPathPolicy.normalize("/a\u0000b"))
        assertNull(GuestPathPolicy.normalize("/a\\b"))
        assertFalse(GuestPathPolicy.validSessionId("../B"))
    }
    @Test fun canonicalContainmentRejectsTraversalPrefixAndSymlink() {
        val root = Files.createTempDirectory("guest-path").toFile()
        try {
            val base = root.resolve("workspace").apply { mkdirs() }
            val outside = root.resolve("workspace-other").apply { mkdirs() }
            assertEquals(base.resolve("nested/new.txt"), GuestPathPolicy.within(base, "nested/new.txt"))
            assertNull(GuestPathPolicy.within(base, "../workspace-other/file"))
            Files.createSymbolicLink(base.resolve("link").toPath(), outside.toPath())
            assertNull(GuestPathPolicy.within(base, "link/file"))
        } finally { root.deleteRecursively() }
    }
}
