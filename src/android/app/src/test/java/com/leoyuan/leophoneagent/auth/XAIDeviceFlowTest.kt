package com.leoyuan.leophoneagent.auth

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class XAIDeviceFlowTest {
    @Test
    fun `parses device authorization and prefers complete URL`() {
        val auth = XAIDeviceFlow.parseDeviceAuthorization(JSONObject("""
            {
              "device_code":"device-secret",
              "user_code":"ABCD-EFGH",
              "verification_uri":"https://accounts.x.ai/device",
              "verification_uri_complete":"https://accounts.x.ai/device?user_code=ABCD-EFGH",
              "expires_in":1800,
              "interval":5
            }
        """))!!
        assertEquals("ABCD-EFGH", auth.userCode)
        assertEquals("https://accounts.x.ai/device?user_code=ABCD-EFGH", auth.openUrl)
        assertEquals(1800L, auth.expiresInSeconds)
    }

    @Test
    fun `rejects missing required device fields`() {
        assertNull(XAIDeviceFlow.parseDeviceAuthorization(JSONObject("""{"user_code":"X"}""")))
    }

    @Test
    fun `classifies poll states without exposing tokens`() {
        assertTrue(XAIDeviceFlow.classifyPoll(JSONObject("""{"error":"authorization_pending"}"""), false) is XAIDeviceFlow.PollResult.Pending)
        assertTrue(XAIDeviceFlow.classifyPoll(JSONObject("""{"error":"slow_down"}"""), false) is XAIDeviceFlow.PollResult.SlowDown)
        assertTrue(XAIDeviceFlow.classifyPoll(JSONObject("""{"access_token":"secret"}"""), true) is XAIDeviceFlow.PollResult.Success)
        assertEquals(10L, XAIDeviceFlow.bumpedInterval(5L))
    }
}
