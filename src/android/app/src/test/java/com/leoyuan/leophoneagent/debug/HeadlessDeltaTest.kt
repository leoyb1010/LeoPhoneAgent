package com.leoyuan.leophoneagent.debug

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** What the phone sends a remote watcher as a turn's answer grows or restarts. */
class HeadlessDeltaTest {
    @Test
    fun growingAnswerSendsOnlyTheNewPart() {
        assertEquals("Hello", HeadlessChatRunner.nextDelta("", "Hello"))
        assertEquals(" world", HeadlessChatRunner.nextDelta("Hello", "Hello world"))
        assertNull(HeadlessChatRunner.nextDelta("Hello", "Hello"))
    }

    @Test
    fun restartedAnswerSendsNothingUntilItPassesWhatIsShown() {
        // An automatic retry starts the text over: the watcher already shows it.
        assertNull(HeadlessChatRunner.nextDelta("Hello wor", ""))
        assertNull(HeadlessChatRunner.nextDelta("Hello wor", "Hel"))
        assertEquals("ld", HeadlessChatRunner.nextDelta("Hello wor", "Hello world"))
    }

    @Test
    fun divergedAnswerNeverResendsTheSharedStart() {
        assertEquals("i there", HeadlessChatRunner.nextDelta("Hello", "Hi there"))
    }
}
