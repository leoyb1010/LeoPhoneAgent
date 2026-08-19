package com.leoyuan.leophoneagent.relay

import org.json.JSONObject

/**
 * QR / paste payload for adding a body. Contains only the relay API root and
 * machine name. The access key never goes in the code — iPhone already has it.
 */
object RelayPairCodec {
    const val PREFIX = "leoagent-body:v1|"

    data class Payload(
        val apiRoot: String,
        val machine: String,
    )

    fun encode(apiRoot: String, machine: String): String {
        val json = JSONObject()
            .put("apiRoot", apiRoot.trim().trimEnd('/'))
            .put("machine", machine.trim())
        return PREFIX + json.toString()
    }

    fun decode(raw: String): Payload? {
        val text = raw.trim()
        val jsonText = when {
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
            else Payload(apiRoot = apiRoot, machine = machine)
        }.getOrNull()
    }
}
