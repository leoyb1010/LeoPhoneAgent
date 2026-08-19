package com.leoyuan.leophoneagent.relay

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

class RelayFleetClient(
    private val config: RelayFleetConfig,
    private val http: OkHttpClient = defaultClient(),
    private val validateHttps: Boolean = true,
) {
    init {
        if (validateHttps) RelayFleetStore.normalizeBase(config.relayApiBase)
        require(config.accessKey.length >= 16) { "未配置中继密钥" }
    }

    suspend fun machines(): List<RelayMachine> = withContext(Dispatchers.IO) {
        val obj = get("/machines")
        obj.optJSONArray("machines").objects().mapNotNull { row ->
            val name = row.optString("name")
            if (name.isBlank()) null else RelayMachine(
                name = name,
                online = row.optBoolean("online", true),
                connectedAt = row.optDoubleOrNull("connected_at"),
                server = row.optStringOrNull("server"),
                version = row.optStringOrNull("version"),
            )
        }
    }

    suspend fun sessions(machine: String): List<RelaySession> = withContext(Dispatchers.IO) {
        val obj = get(machinePath(machine, "/harness/sessions"))
        obj.optJSONArray("sessions").objects().mapNotNull { row ->
            val id = row.optString("session_id", row.optString("id"))
            if (id.isBlank()) null else RelaySession(
                id = id,
                harness = row.optString("harness", "unknown"),
                status = row.optString("status", "unknown"),
                cwd = row.optStringOrNull("cwd"),
                lastEvent = row.optStringOrNull("last_event"),
            )
        }
    }

    suspend fun startTask(
        machine: String,
        prompt: String,
        harness: String = "codex",
        cwd: String = "~",
    ): String = withContext(Dispatchers.IO) {
        require(prompt.isNotBlank()) { "任务内容不能为空" }
        val body = JSONObject()
            .put("harness", harness)
            .put("cwd", cwd.ifBlank { "~" })
            .put("prompt", prompt.trim())
        val obj = post(machinePath(machine, "/harness/sessions"), body)
        obj.optString("session_id").takeIf { it.isNotBlank() }
            ?: throw RelayException("远程机器未返回会话 ID")
    }

    suspend fun send(machine: String, sessionId: String, text: String) = withContext(Dispatchers.IO) {
        post(machinePath(machine, "/harness/sessions/${enc(sessionId)}/send"), JSONObject().put("text", text))
        Unit
    }

    suspend fun stop(machine: String, sessionId: String) = withContext(Dispatchers.IO) {
        post(machinePath(machine, "/harness/sessions/${enc(sessionId)}/stop"), JSONObject())
        Unit
    }

    suspend fun approve(
        machine: String,
        sessionId: String,
        approvalId: String,
        choice: String,
    ) = withContext(Dispatchers.IO) {
        val body = JSONObject().put("approval_id", approvalId).put("choice", choice)
        post(machinePath(machine, "/harness/sessions/${enc(sessionId)}/approval"), body)
        Unit
    }

    suspend fun relayEvents(after: Double): RelayEventBatch = withContext(Dispatchers.IO) {
        val obj = get("/events?after=$after")
        var highWater = after
        val approvals = obj.optJSONArray("events").objects().mapNotNull { envelope ->
            highWater = maxOf(highWater, envelope.optDouble("received_at", after))
            val row = envelope.optJSONObject("event") ?: return@mapNotNull null
            if (row.optString("event") != "approval.request") return@mapNotNull null
            val machine = envelope.optString("machine")
            val session = row.optString("session_id")
            val approval = row.optString("approval_id", row.optString("request_id"))
            if (machine.isBlank() || session.isBlank() || approval.isBlank()) null else RelayApproval(
                machine = machine,
                sessionId = session,
                approvalId = approval,
                command = row.optStringOrNull("command"),
                description = row.optStringOrNull("description"),
                choices = row.optJSONArray("choices").strings().ifEmpty { listOf("once", "deny") },
                seq = row.optInt("seq", 0),
            )
        }
        // Advance only to the newest event actually observed. Advancing to
        // the server's `now` can skip an event written between snapshotting
        // the rows and serializing that timestamp.
        RelayEventBatch(approvals, highWater)
    }

    private fun machinePath(machine: String, tail: String) = "/m/${enc(machine)}$tail"

    private fun get(path: String): JSONObject = execute(
        Request.Builder().url(resolve(path)).get().authorized().build(),
    )

    private fun post(path: String, body: JSONObject): JSONObject = execute(
        Request.Builder()
            .url(resolve(path))
            .post(body.toString().toRequestBody(JSON))
            .authorized()
            .build(),
    )

    private fun Request.Builder.authorized() = header("Authorization", "Bearer ${config.accessKey}")
        .header("Accept", "application/json")

    private fun execute(request: Request): JSONObject {
        http.newCall(request).execute().use { response ->
            val raw = response.body?.string().orEmpty()
            val obj = runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
            if (!response.isSuccessful) {
                val message = obj.optJSONObject("error")?.optString("message")
                    .takeUnless { it.isNullOrBlank() }
                    ?: obj.optString("message").takeUnless { it.isBlank() }
                    ?: "HTTP ${response.code}"
                throw RelayException(if (response.code in listOf(401, 403)) "中继密钥被拒绝" else message)
            }
            return obj
        }
    }

    private fun resolve(path: String): String = config.relayApiBase.trimEnd('/') + path

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private fun enc(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
        private fun defaultClient() = OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()

        internal fun forTest(config: RelayFleetConfig, http: OkHttpClient): RelayFleetClient =
            RelayFleetClient(config, http, validateHttps = false)
    }
}

private fun JSONArray?.objects(): List<JSONObject> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

private fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { optString(it).takeIf(String::isNotBlank) }

private fun JSONObject.optStringOrNull(key: String): String? =
    optString(key).takeIf { it.isNotBlank() && it != "null" }

private fun JSONObject.optDoubleOrNull(key: String): Double? =
    if (has(key) && !isNull(key)) optDouble(key) else null
