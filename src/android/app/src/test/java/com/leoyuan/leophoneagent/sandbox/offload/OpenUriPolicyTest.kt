package com.leoyuan.leophoneagent.sandbox.offload

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * review P0#3：`android-open` 用 `Intent.parseUri(url, URI_INTENT_SCHEME)`，
 * 而 `intent:` URI 可以内联 `component=pkg/cls` —— 解析出来是**显式** Intent，
 * 绕过 intent-filter 匹配，能拉起任意 exported activity。
 * 走到这条工具通道的字符串未必来自用户（Agent 从网页抓回来的内容也在内）。
 */
class OpenUriPolicyTest {

    @Test
    fun `plain urls are not intent-style`() {
        listOf(
            "https://example.com/a?component=x",
            "tel:+8613800138000",
            "mailto:a@b.c",
            "geo:0,0?q=cafe",
            "market://details?id=com.foo",
        ).forEach {
            assertFalse(it, OpenUriPolicy.isIntentStyleUri(it))
            assertFalse(it, OpenUriPolicy.declaresExplicitComponent(it))
        }
    }

    @Test
    fun `intent uri with explicit component is refused`() {
        assertTrue(
            OpenUriPolicy.declaresExplicitComponent(
                "intent://x#Intent;scheme=https;component=com.victim/.SecretActivity;end",
            ),
        )
        // 大小写、前置空格、位于片段开头都要覆盖。
        assertTrue(
            OpenUriPolicy.declaresExplicitComponent(
                "intent://x#Intent;COMPONENT=com.victim/.A;end",
            ),
        )
        assertTrue(
            OpenUriPolicy.declaresExplicitComponent(
                "intent://x#component=com.victim/.A;end",
            ),
        )
        assertTrue(
            OpenUriPolicy.declaresExplicitComponent(
                "android-app://com.victim#Intent;component=com.victim/.A;end",
            ),
        )
    }

    @Test
    fun `explicit component hidden in a nested selector is refused`() {
        // parseUri 在部分 API level 上把 SEL 段里的 component 挂到 selector 上，
        // 顶层 intent.component 仍是 null —— 文本预检必须自己接住。
        assertTrue(
            OpenUriPolicy.declaresExplicitComponent(
                "intent://x#Intent;scheme=https;SEL;component=com.victim/.A;end;end",
            ),
        )
    }

    @Test
    fun `package scoping stays allowed`() {
        // `package=` 仍然要过 intent-filter 匹配，只是把候选收窄到某个 App，
        // 这是 market: / 深链的正常用法，不能一起拒掉。
        assertFalse(
            OpenUriPolicy.declaresExplicitComponent(
                "intent://details?id=com.foo#Intent;scheme=market;package=com.android.vending;end",
            ),
        )
        assertFalse(
            OpenUriPolicy.declaresExplicitComponent(
                "intent:#Intent;action=android.intent.action.SET_ALARM;i.android.intent.extra.alarm.HOUR=7;end",
            ),
        )
    }

    @Test
    fun `a query parameter that merely contains the word component is not a component`() {
        assertFalse(
            OpenUriPolicy.declaresExplicitComponent(
                "intent://x?ui_component=header#Intent;scheme=https;package=com.foo;end",
            ),
        )
    }
}
