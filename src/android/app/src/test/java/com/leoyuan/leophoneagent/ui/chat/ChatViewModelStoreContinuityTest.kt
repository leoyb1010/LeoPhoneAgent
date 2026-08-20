package com.leoyuan.leophoneagent.ui.chat

import org.junit.Assert.assertSame
import org.junit.Test

/**
 * Fold / rotation used to recreate MainActivity. The process-level store must
 * still hand back the same ViewModelStore for a session so the agent loop and
 * composer draft survive that recreation (and configChanges is belt-and-suspenders).
 */
class ChatViewModelStoreContinuityTest {
    @Test
    fun `same session reuses the live ViewModelStore after a fake recreation`() {
        val sessionId = "__fold_continuity_test__"
        try {
            val first = ChatViewModelStore.ownerFor(sessionId).viewModelStore
            val afterRecreation = ChatViewModelStore.ownerFor(sessionId).viewModelStore
            assertSame(first, afterRecreation)
        } finally {
            ChatViewModelStore.release(sessionId)
        }
    }

    @Test
    fun `draft alias keeps pointing at the renamed store`() {
        val draft = "__new__fold-draft"
        val canonical = "canonical-fold-session"
        try {
            val original = ChatViewModelStore.ownerFor(draft).viewModelStore
            ChatViewModelStore.rename(draft, canonical)
            assertSame(original, ChatViewModelStore.ownerFor(draft).viewModelStore)
            assertSame(original, ChatViewModelStore.ownerFor(canonical).viewModelStore)
        } finally {
            ChatViewModelStore.release(canonical)
            ChatViewModelStore.release(draft)
        }
    }
}
