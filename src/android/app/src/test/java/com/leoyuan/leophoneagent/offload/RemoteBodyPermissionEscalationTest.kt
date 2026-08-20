package com.leoyuan.leophoneagent.offload

import com.leoyuan.leophoneagent.offload.OffloadPermissionManager.PermissionCategory
import com.leoyuan.leophoneagent.offload.OffloadPermissionManager.PermissionLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * review P0#2：远程可以零确认读走通讯录 / 定位 / 相册 / 剪贴板 / 日历。
 * 根因是 PRIVACY 组默认全 BYPASS，而 relay 侧根本没有 approval 通道
 * （`approval_events: false`，任何 `/approval` 一律 409）。
 */
class RemoteBodyPermissionEscalationTest {

    @Test
    fun `privacy bypass is raised to ask-once while the remote body is on`() {
        assertEquals(
            PermissionLevel.ASK_ONCE,
            OffloadPermissionManager.effectiveLevel(
                PermissionCategory.PRIVACY,
                PermissionLevel.BYPASS,
                remoteBody = true,
            ),
        )
    }

    @Test
    fun `privacy bypass stays bypass for local-only use`() {
        assertEquals(
            PermissionLevel.BYPASS,
            OffloadPermissionManager.effectiveLevel(
                PermissionCategory.PRIVACY,
                PermissionLevel.BYPASS,
                remoteBody = false,
            ),
        )
    }

    @Test
    fun `escalation never downgrades an explicit user choice`() {
        // 用户显式关掉的工具不能因为提级逻辑反而变成"会弹窗即可用"。
        assertEquals(
            PermissionLevel.NOT_ALLOWED,
            OffloadPermissionManager.effectiveLevel(
                PermissionCategory.PRIVACY,
                PermissionLevel.NOT_ALLOWED,
                remoteBody = true,
            ),
        )
        assertEquals(
            PermissionLevel.ASK_ONCE,
            OffloadPermissionManager.effectiveLevel(
                PermissionCategory.PRIVACY,
                PermissionLevel.ASK_ONCE,
                remoteBody = true,
            ),
        )
    }

    @Test
    fun `non-privacy categories are untouched`() {
        for (category in listOf(
            PermissionCategory.MEDIA,
            PermissionCategory.SYSTEM,
            PermissionCategory.INTEGRATIONS,
        )) {
            assertEquals(
                "category=$category must not be escalated",
                PermissionLevel.BYPASS,
                OffloadPermissionManager.effectiveLevel(
                    category,
                    PermissionLevel.BYPASS,
                    remoteBody = true,
                ),
            )
        }
    }

    @Test
    fun `every privacy tool the relay can reach is covered by the escalation`() {
        val privacy = OffloadPermissionManager.toolRegistry
            .filter { it.category == PermissionCategory.PRIVACY }
            .map { it.toolName }
            .toSet()
        assertEquals(
            setOf("calendar", "location", "clipboard", "contacts", "photos"),
            privacy,
        )
        OffloadPermissionManager.toolRegistry
            .filter { it.category == PermissionCategory.PRIVACY }
            .forEach {
                assertEquals(
                    "${it.toolName} must escalate under a remote body",
                    PermissionLevel.ASK_ONCE,
                    OffloadPermissionManager.effectiveLevel(
                        it.category,
                        it.defaultLevel,
                        remoteBody = true,
                    ),
                )
                assertTrue("${it.toolName} must stay user-visible", it.showInSettings)
            }
    }

    /** review P0#3：`android-open` 过去根本没注册，设置页看不见也关不掉。 */
    @Test
    fun `android-open is registered and visible in settings`() {
        val open = OffloadPermissionManager.toolRegistry.find { it.toolName == "open" }
        assertNotNull("android-open must be registered so OffloadGate can enforce it", open)
        assertTrue("android-open must be user-visible", open!!.showInSettings)
    }

    /** review 明确要求不要动这两处：它们本来就是对的。 */
    @Test
    fun `integration tools stay opt-in`() {
        OffloadPermissionManager.toolRegistry
            .filter { it.category == PermissionCategory.INTEGRATIONS && it.toolName.endsWith("_cli") }
            .forEach { assertEquals(PermissionLevel.NOT_ALLOWED, it.defaultLevel) }
    }
}
