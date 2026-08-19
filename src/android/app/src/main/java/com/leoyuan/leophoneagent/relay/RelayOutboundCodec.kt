package com.leoyuan.leophoneagent.relay

import org.json.JSONObject

/** Frame codec for the existing Leo relay agent WebSocket. No network I/O. */
object RelayOutboundCodec {
    fun agentWsUrl(apiBase: String): String {
        var url = apiBase.trim().trimEnd('/')
        url = url.replace(Regex("^https://", RegexOption.IGNORE_CASE), "wss://")
            .replace(Regex("^http://", RegexOption.IGNORE_CASE), "ws://")
        url = url.replace(Regex("/relay/api$"), "/relay/agent")
        if (!url.endsWith("/relay/agent")) {
            url = if (url.endsWith("/relay")) "$url/agent" else "$url/relay/agent"
        }
        return url
    }

    fun registerFrame(name: String, key: String, version: String): JSONObject =
        JSONObject()
            .put("type", "register")
            .put("name", name)
            .put("key", key)
            .put(
                "info",
                JSONObject()
                    .put("platform", "android")
                    .put("server", "minis")
                    .put("version", version),
            )

    fun parse(raw: String): JSONObject? =
        runCatching { JSONObject(raw) }.getOrNull()

    fun resp(id: Any?, status: Int, body: Any): JSONObject =
        JSONObject().put("type", "resp").put("id", id).put("status", status).put("body", body)

    fun streamData(id: String, data: String): JSONObject =
        JSONObject().put("type", "stream_data").put("id", id).put("data", data)

    fun streamClose(id: String): JSONObject =
        JSONObject().put("type", "stream_close").put("id", id)

    fun ssePayload(line: String): String? {
        val trimmed = line.trim()
        if (!trimmed.startsWith("data:")) return null
        return trimmed.removePrefix("data:").trim().takeIf { it.isNotEmpty() }
    }
}
