package com.leoyuan.leophoneagent.util

import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class EncryptedPrefsRecoveryTest {
    @Test fun temporaryFailureRetriesOriginalCiphertext() {
        val file = Files.createTempFile("ciphertext", ".xml").toFile()
        try {
            file.writeText("encrypted-original")
            var calls = 0
            val result = EncryptedPrefsRecovery.open(create = {
                calls++
                if (calls == 1) throw java.io.IOException("temporary keystore failure")
                file.readText()
            }, failed = {})
            assertEquals(2, calls)
            assertEquals("encrypted-original", result)
            assertEquals("encrypted-original", file.readText())
        } finally { file.delete() }
    }
    @Test fun persistentFailureDoesNotAuthorizeDeletionOrAliasReplacement() {
        var calls = 0
        val result = EncryptedPrefsRecovery.open<String>(create = {
            calls++
            throw java.security.GeneralSecurityException("unavailable")
        }, failed = {})
        assertNull(result)
        assertEquals(2, calls)
    }
    @Test fun successfulOpenDoesNotRetry() {
        var calls = 0
        assertEquals("stored", EncryptedPrefsRecovery.open({ calls++; "stored" }, {}))
        assertEquals(1, calls)
    }
}
