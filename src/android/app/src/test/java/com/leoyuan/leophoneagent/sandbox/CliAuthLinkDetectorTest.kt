package com.leoyuan.leophoneagent.sandbox

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CliAuthLinkDetectorTest {
    private val allowed = setOf("auth.openai.com", "chatgpt.com")

    @Test
    fun `official https auth link is detected`() {
        assertEquals(
            "https://auth.openai.com/oauth/authorize?state=abc",
            CliAuthLinkDetector.firstAllowed(
                "Open https://auth.openai.com/oauth/authorize?state=abc to continue",
                allowed,
            ),
        )
    }

    @Test
    fun `unknown host http userinfo and deceptive suffix fail closed`() {
        assertNull(CliAuthLinkDetector.firstAllowed("https://evil.example/login", allowed))
        assertNull(CliAuthLinkDetector.firstAllowed("http://auth.openai.com/login", allowed))
        assertNull(CliAuthLinkDetector.firstAllowed("https://evil@auth.openai.com/login", allowed))
        assertNull(CliAuthLinkDetector.firstAllowed("https://auth.openai.com.evil.example/login", allowed))
    }

    @Test
    fun `grok device authorization host is allowlisted by its catalog entry`() {
        val grok = CliToolCatalog.get(CliToolId.GROK)
        assertEquals(
            "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
            CliAuthLinkDetector.firstAllowed(
                "Open https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
                grok.authHosts,
            ),
        )
    }
}
