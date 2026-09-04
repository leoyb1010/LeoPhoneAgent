package com.leoyuan.leophoneagent.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UpdateCheckerTest {
    private val standard = "a".repeat(64)
    private val power = "b".repeat(64)
    private val body = """
        Release notes
        Standard SHA-256: $standard
        Power SHA-256: $power
    """.trimIndent()

    @Test
    fun releaseDigestMatchesInstalledEdition() {
        assertEquals(standard, UpdateChecker.releaseSha256(body, power = false))
        assertEquals(power, UpdateChecker.releaseSha256(body, power = true))
    }

    @Test
    fun releaseDigestRejectsMissingOrMalformedValue() {
        assertNull(UpdateChecker.releaseSha256("Standard SHA-256: abc", power = false))
        assertNull(UpdateChecker.releaseSha256("Power SHA-256: $power", power = false))
    }

    @Test
    fun androidReleaseTagsKeepTheAlphaSequence() {
        assertEquals("1.0.0-alpha.25", UpdateChecker.normalizeTag("android-v1.0.0-alpha.25"))
        assertEquals("1.0.0-alpha.24", UpdateChecker.normalizeTag("1.0.0-alpha.24-power"))
        assertEquals(
            1,
            UpdateChecker.compareVersions("1.0.0-alpha.25", "1.0.0-alpha.24"),
        )
    }
}
