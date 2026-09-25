package com.leoyuan.leophoneagent.data.repository

import com.leoyuan.leophoneagent.data.model.ModelGroup
import org.junit.Assert.assertEquals
import org.junit.Test

/** Deleting a provider removes only the groups that deletion empties. */
class ProviderRepositoryRemovalTest {

    @Test
    fun `groupsEmptiedBy keeps mixed groups and groups the user left empty`() {
        val groups = listOf(
            ModelGroup(id = "only-removed", name = "A", memberEntryIds = mutableListOf("e1", "e2")),
            ModelGroup(id = "mixed", name = "B", memberEntryIds = mutableListOf("e1", "keep")),
            ModelGroup(id = "empty-by-design", name = "C"),
        )
        assertEquals(setOf("only-removed"), ProviderRepository.groupsEmptiedBy(groups, setOf("e1", "e2")))
    }
}
