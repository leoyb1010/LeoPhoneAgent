package com.leoyuan.leophoneagent.relay

import org.json.JSONObject

/**
 * QR / paste payload for adding a body. Contains only the relay API root and
 * machine name. The access key never goes in the code — iPhone already has it.
 */
object RelayPairCodec {
    const val PREFIX = "leoagent-body:v1|"
    const val PREFIX_V2 = "leoagent-body:v2|"

    data class Payload(
        val apiRoot: String,
        val machine: String,
        val join: String? = null,
        val exp: Long? = null,
    )

    fun encode(apiRoot: String, machine: String, join: String? = null, exp: Long? = null): String {
        val json = JSONObject()
            .put("apiRoot", apiRoot.trim().trimEnd('/'))
            .put("machine", machine.trim())
        val token = join?.trim().orEmpty()
        if (token.isNotEmpty()) {
            json.put("join", token)
            if (exp != null) json.put("exp", exp)
            return PREFIX_V2 + json.toString()
        }
        return PREFIX + json.toString()
    }

    fun decode(raw: String): Payload? {
        val text = raw.trim()
        val jsonText = when {
            text.startsWith(PREFIX_V2) -> text.removePrefix(PREFIX_V2)
            text.startsWith(PREFIX) -> text.removePrefix(PREFIX)
            text.startsWith("{") -> text
            else -> return null
        }
        return runCatching {
            val obj = JSONObject(jsonText)
            val apiRoot = obj.optString("apiRoot").trim().trimEnd('/')
            val machine = obj.optString("machine").trim()
            if (apiRoot.isEmpty() || machine.isEmpty()) null
            else if (!apiRoot.startsWith("https://", ignoreCase = true)) null
            else if (machine.contains('/') || machine.contains('\\') || machine.contains("..")) null
            else {
                val join = obj.optString("join").trim().takeIf { it.isNotEmpty() }
                val exp = if (obj.has("exp") && !obj.isNull("exp")) obj.optLong("exp") else null
                Payload(apiRoot = apiRoot, machine = machine, join = join, exp = exp)
            }
        }.getOrNull()
    }
}
