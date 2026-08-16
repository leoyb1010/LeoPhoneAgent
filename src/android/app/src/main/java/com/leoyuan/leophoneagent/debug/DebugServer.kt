package com.leoyuan.leophoneagent.debug

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.PrintWriter
import java.net.ServerSocket
import java.net.Socket
import java.net.InetAddress

/**
 * Debug-only JSON-RPC 2.0 server on port 5321.
 * Listens on device loopback and is reached through adb forwarding.
 * Mirrors the iOS DebugServer for parity with the debug-server CLI skill.
 *
 * IMPORTANT: Only start this in debug builds. Never start in release.
 */
class DebugServer(
    private val context: Context,
    private val port: Int = 5321,
) {
    companion object {
        private const val TAG = "DebugServer"
        private const val MAX_REQUEST_BODY_BYTES = 1_048_576

        /**
         * [T-android-debugserver-auth] Remote-connection auth decision, kept
         * pure for unit testing. Android apps share the device network
         * namespace, so loopback is not an authentication boundary: every
         * client, including adb-forwarded tooling, must present the token.
         */
        fun isAuthorized(isLoopback: Boolean, providedToken: String?, expectedToken: String): Boolean {
            if (expectedToken.isEmpty()) return false
            val provided = providedToken ?: return false
            if (provided.length != expectedToken.length) return false
            // Constant-time compare — don't leak the token via timing.
            var diff = 0
            for (i in expectedToken.indices) {
                diff = diff or (provided[i].code xor expectedToken[i].code)
            }
            return diff == 0
        }
    }

    private var serverSocket: ServerSocket? = null
    private var acceptJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)
    private val rpcHandler = DebugRPCHandler(context)

    /**
     * [T-android-debugserver-auth] Per-install token required from every
     * client. Generated once, persisted in filesDir so the
     * developer can read it with:
     *   adb shell run-as com.leoyuan.leophoneagent cat files/debug_server_token
     * The token itself is never written to logcat.
     */
    private val authToken: String by lazy {
        val f = java.io.File(context.filesDir, "debug_server_token")
        if (f.exists()) {
            f.readText().trim().ifEmpty { generateToken(f) }
        } else {
            generateToken(f)
        }
    }

    private fun generateToken(f: java.io.File): String {
        val bytes = ByteArray(24)
        java.security.SecureRandom().nextBytes(bytes)
        val token = bytes.joinToString("") { "%02x".format(it) }
        runCatching { f.writeText(token) }
        return token
    }

    @Volatile
    private var stopped = false

    fun start() {
        if (serverSocket != null) return
        stopped = false

        acceptJob = scope.launch {
            try {
                // Debug RPC is device-local only. adb forward still reaches
                // this socket, while the LAN never can.
                val ss = ServerSocket(port, 10, InetAddress.getLoopbackAddress())
                serverSocket = ss
                Log.i(TAG, "Debug server listening on loopback port $port; token required")

                while (!stopped) {
                    try {
                        val client = ss.accept()
                        launch { handleConnection(client) }
                    } catch (e: Exception) {
                        if (!stopped) Log.w(TAG, "Accept error: ${e.message}")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to start server on port $port: ${e.message}")
            }
        }
    }

    fun stop() {
        stopped = true
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
        acceptJob?.cancel()
        acceptJob = null
        Log.i(TAG, "Server stopped")
    }

    private fun handleConnection(socket: Socket) {
        socket.use { s ->
            try {
                s.soTimeout = 30_000
                val reader = BufferedReader(InputStreamReader(s.getInputStream()))
                val writer = PrintWriter(s.getOutputStream(), true)

                // Read HTTP request line
                val requestLine = reader.readLine() ?: return
                val parts = requestLine.split(" ", limit = 3)
                if (parts.size < 2) {
                    sendResponse(writer, 400, rpcHandler.errorJSON(-32700, "Parse error"))
                    return
                }
                val method = parts[0]
                // [T-android-debugserver-skill] Path (query stripped) so the
                // authenticated GET skill routes can be dispatched.
                val path = parts.getOrNull(1)?.substringBefore('?') ?: "/"

                // Handle CORS preflight
                if (method == "OPTIONS") {
                    sendCorsPreflightResponse(writer)
                    return
                }

                // Read headers
                var contentLength = 0
                var providedToken: String? = null
                var accept = ""
                while (true) {
                    val headerLine = reader.readLine() ?: break
                    if (headerLine.isEmpty()) break
                    val lower = headerLine.lowercase()
                    if (lower.startsWith("content-length:")) {
                        contentLength = headerLine.substringAfter(":").trim().toIntOrNull() ?: 0
                    }
                    if (lower.startsWith("accept:")) {
                        accept = lower.substringAfter(":").trim()
                    }
                    // [T-android-debugserver-auth] Token via X-LeoPhoneAgent-Token or
                    // Authorization: Bearer — either spelling accepted.
                    if (lower.startsWith("x-minis-token:") || lower.startsWith("x-leophoneagent-token:")) {
                        providedToken = headerLine.substringAfter(":").trim()
                    }
                    if (lower.startsWith("authorization:")) {
                        val v = headerLine.substringAfter(":").trim()
                        if (v.lowercase().startsWith("bearer ")) {
                            providedToken = v.substring(7).trim()
                        }
                    }
                }

                // [T-android-debugserver-auth] Gate BEFORE any RPC dispatch:
                // Loopback is shared by every app on-device, so it is not
                // exempt. The token is required before every route/RPC.
                val isLoopback = s.inetAddress?.isLoopbackAddress == true
                if (!isAuthorized(isLoopback, providedToken, authToken)) {
                    Log.w(TAG, "401 unauthorized ${if (isLoopback) "loopback" else s.inetAddress?.hostAddress ?: "?"} (missing/wrong token)")
                    sendResponse(writer, 401, rpcHandler.errorJSON(-32000, "Unauthorized — send X-LeoPhoneAgent-Token (see `adb shell run-as com.leoyuan.leophoneagent cat files/debug_server_token`)"))
                    return
                }

                // [T-android-debugserver-skill] Self-serve bootstrap routes,
                // mirroring iOS: a client that only has curl can pull the manual
                // and a working reference client straight off the device.
                //
                // Deliberately placed AFTER the auth gate above: unlike iOS
                // (whose /skill is unauthenticated because every RPC is still
                // sealed by the v1 envelope), Android's RPCs are plaintext, so
                // the token remains mandatory even over `adb forward`.
                if (method == "GET") {
                    val wantsHuman = accept.contains("text/html") ||
                        accept.contains("text/markdown") ||
                        accept.contains("text/plain")
                    when (path) {
                        "/schema" -> {
                            sendResponse(writer, 200, schemaJSON())
                            return
                        }
                        "/", "/skill", "/skill/" -> {
                            // A bare `GET /` from a tool (no human Accept) keeps
                            // returning the machine schema, same contract as iOS.
                            if (path == "/" && !wantsHuman) {
                                sendResponse(writer, 200, schemaJSON())
                            } else {
                                sendSkill(writer, wantsHuman)
                            }
                            return
                        }
                        "/skill/examples/python", "/skill/examples/minis_rpc_android.py" -> {
                            sendSkillAsset(writer, "examples/minis_rpc_android.py", "text/x-python; charset=utf-8")
                            return
                        }
                        "/skill/examples/curl", "/skill/examples/curl.md" -> {
                            sendSkillAsset(writer, "examples/curl.md", "text/markdown; charset=utf-8")
                            return
                        }
                    }
                }

                if (method != "POST") {
                    sendResponse(writer, 405, rpcHandler.errorJSON(-32600, "Only POST accepted"))
                    return
                }

                if (contentLength <= 0) {
                    sendResponse(writer, 400, rpcHandler.errorJSON(-32700, "Empty body"))
                    return
                }
                if (contentLength > MAX_REQUEST_BODY_BYTES) {
                    sendResponse(writer, 413, rpcHandler.errorJSON(-32600, "Request body too large"))
                    return
                }

                // Read body
                val body = CharArray(contentLength)
                var totalRead = 0
                while (totalRead < contentLength) {
                    val n = reader.read(body, totalRead, contentLength - totalRead)
                    if (n < 0) break
                    totalRead += n
                }
                val jsonBody = String(body, 0, totalRead)

                val responseJSON = runBlocking {
                    rpcHandler.handle(jsonBody)
                }

                sendResponse(writer, 200, responseJSON)
            } catch (e: Exception) {
                Log.w(TAG, "Connection error: ${e.message}")
            }
        }
    }

    /// [T-android-debugserver-skill] Capability descriptor. Mirrors the iOS
    /// shape so a shared client can detect the platform. Android debug RPC is
    /// loopback-only and requires a token on every request.
    private fun schemaJSON(): String {
        val version = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "?"
        } catch (_: Exception) {
            "?"
        }
        return """{"app":"MinisApp","platform":"android","version":"$version",""" +
            """"rpc":"jsonrpc-2.0","auth":"token-required","transport":"plaintext-loopback",""" +
            """"rpc_path":"/","skill_path":"/skill"}"""
    }

    /// GET / and /skill. Human clients get raw markdown; tools get JSON with the
    /// manual plus every reference client inlined, so one request bootstraps.
    private fun sendSkill(writer: PrintWriter, wantsHuman: Boolean) {
        val skill = readSkillAsset("SKILL.md")
        if (skill == null) {
            sendResponse(writer, 503, """{"error":"skill assets not bundled in this build"}""")
            return
        }
        if (wantsHuman) {
            sendResponse(writer, 200, skill, "text/markdown; charset=utf-8")
            return
        }
        val py = readSkillAsset("examples/minis_rpc_android.py") ?: ""
        val curl = readSkillAsset("examples/curl.md") ?: ""
        val payload = org.json.JSONObject().apply {
            put("skill", skill)
            put("clients", org.json.JSONObject().apply {
                put("python", py)
                put("curl", curl)
            })
            put("client_paths", org.json.JSONObject().apply {
                put("python", "/skill/examples/python")
                put("curl", "/skill/examples/curl")
            })
        }
        sendResponse(writer, 200, payload.toString())
    }

    private fun sendSkillAsset(writer: PrintWriter, assetPath: String, contentType: String) {
        val body = readSkillAsset(assetPath)
        if (body == null) {
            sendResponse(writer, 503, """{"error":"asset not bundled: $assetPath"}""")
            return
        }
        sendResponse(writer, 200, body, contentType)
    }

    /// Reads from the DEBUG-only asset source set staged by
    /// scripts/gen_debug_skill_android.sh. Absent in release (where this whole
    /// server never starts) and absent if the generator didn't run.
    private fun readSkillAsset(relPath: String): String? = try {
        context.assets.open("debug-skill/$relPath").bufferedReader().use { it.readText() }
    } catch (_: Exception) {
        null
    }

    private fun sendResponse(
        writer: PrintWriter,
        statusCode: Int,
        body: String,
        contentType: String = "application/json",
    ) {
        val statusText = when (statusCode) {
            200 -> "OK"
            400 -> "Bad Request"
            401 -> "Unauthorized"
            405 -> "Method Not Allowed"
            503 -> "Service Unavailable"
            else -> "Error"
        }
        val bytes = body.toByteArray(Charsets.UTF_8)
        writer.print("HTTP/1.1 $statusCode $statusText\r\n")
        writer.print("Content-Type: $contentType\r\n")
        writer.print("Content-Length: ${bytes.size}\r\n")
        writer.print("Connection: close\r\n")
        writer.print("Access-Control-Allow-Origin: *\r\n")
        writer.print("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
        writer.print("Access-Control-Allow-Headers: Content-Type, X-LeoPhoneAgent-Token, Authorization\r\n")
        writer.print("\r\n")
        writer.print(body)
        writer.flush()
    }

    private fun sendCorsPreflightResponse(writer: PrintWriter) {
        writer.print("HTTP/1.1 204 No Content\r\n")
        writer.print("Access-Control-Allow-Origin: *\r\n")
        writer.print("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n")
        writer.print("Access-Control-Allow-Headers: Content-Type, X-LeoPhoneAgent-Token, Authorization\r\n")
        writer.print("Access-Control-Max-Age: 86400\r\n")
        writer.print("Connection: close\r\n")
        writer.print("\r\n")
        writer.flush()
    }
}
