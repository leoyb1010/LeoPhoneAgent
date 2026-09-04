package com.leoyuan.leophoneagent.data.db

import org.junit.Assert.assertEquals
import org.junit.Test

class DatabaseVersionGuardTest {
    @Test fun `only a newer database blocks startup`() {
        assertEquals(DatabaseVersionGuard.Decision.PROCEED, DatabaseVersionGuard.decision(null))
        assertEquals(DatabaseVersionGuard.Decision.PROCEED, DatabaseVersionGuard.decision(12))
        assertEquals(DatabaseVersionGuard.Decision.PROCEED, DatabaseVersionGuard.decision(11))
        assertEquals(DatabaseVersionGuard.Decision.SHOW_NEWER_DB_GUIDANCE, DatabaseVersionGuard.decision(13))
    }
}
