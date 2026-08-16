package com.leoyuan.leophoneagent.auth

import org.json.JSONObject

/** Pure RFC 8628 response parsing for xAI device-code login. */
object XAIDeviceFlow {
    const val GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

    data class DeviceAuthorization(
        val deviceCode: String,
        val userCode: String,
        val verificationUri: String,
        val verificationUriComplete: String?,
        val expiresInSeconds: Long,
        val intervalSeconds: Long,
    ) {
        val openUrl: String get() = verificationUriComplete ?: verificationUri
    }

    fun parseDeviceAuthorization(json: JSONObject): DeviceAuthorization? {
        val deviceCode = json.optString("device_code", "").ifBlank { return null }
        val userCode = json.optString("user_code", "").ifBlank { return null }
        val verificationUri = json.optString("verification_uri", "").ifBlank { return null }
        val verificationUriComplete = json.optString("verification_uri_complete", "")
            .ifBlank { null }
        return DeviceAuthorization(
            deviceCode = deviceCode,
            userCode = userCode,
            verificationUri = verificationUri,
            verificationUriComplete = verificationUriComplete,
            expiresInSeconds = json.optLong("expires_in", 0).takeIf { it > 0 } ?: 900L,
            intervalSeconds = json.optLong("interval", 0).takeIf { it > 0 } ?: 5L,
        )
    }

    sealed class PollResult {
        data class Success(val tokens: JSONObject) : PollResult()
        object Pending : PollResult()
        object SlowDown : PollResult()
        data class Denied(val description: String) : PollResult()
        data class Expired(val description: String) : PollResult()
        data class Fatal(val description: String) : PollResult()
    }

    fun classifyPoll(json: JSONObject, httpOK: Boolean): PollResult {
        if (httpOK && json.optString("access_token", "").isNotBlank()) {
            return PollResult.Success(json)
        }
        val error = json.optString("error", "").lowercase().ifBlank { "unknown_error" }
        val description = json.optString("error_description", "").ifBlank { error }
        return when (error) {
            "authorization_pending" -> PollResult.Pending
            "slow_down" -> PollResult.SlowDown
            "access_denied" -> PollResult.Denied(description)
            "expired_token" -> PollResult.Expired(description)
            else -> PollResult.Fatal(description)
        }
    }

    fun bumpedInterval(currentSeconds: Long): Long = currentSeconds + 5L
}
