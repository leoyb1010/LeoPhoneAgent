package com.leoyuan.leophoneagent.sandbox

import android.content.Context
import com.leoyuan.leophoneagent.data.repository.ProviderRepository
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.UUID

sealed interface CliChatChunk {
    data class Delta(val text: String) : CliChatChunk
    data class Completed(val output: String) : CliChatChunk
    data class Failed(val message: String) : CliChatChunk
}

/**
 * Non-terminal chat surface for the four developer CLIs installed in PRoot.
 * A prompt is written to an app-private, per-session file and referenced by a
 * constant shell command. User text and API keys therefore never appear in
 * command logs, process arguments assembled by Android, navigation routes, or
 * persistent shell history.
 */
class CliChatEngine(
    private val context: Context,
    private val providers: ProviderRepository,
) {
    fun runTurn(
        sessionId: String,
        toolId: CliToolId,
        prompt: String,
    ): Flow<CliChatChunk> = callbackFlow {
        val safeSessionId = sessionId.takeIf { it.matches(Regex("[A-Za-z0-9_-]{1,160}")) }
        if (safeSessionId == null) {
            trySend(CliChatChunk.Failed("Invalid chat session identifier"))
            close()
            return@callbackFlow
        }

        val spec = CliToolCatalog.get(toolId)
        val preference = CliToolPreferences(context).get(toolId)
        val launch = CliToolLaunchResolver.resolve(spec, preference, providers)
        if (launch is CliLaunchResolution.Failed) {
            trySend(CliChatChunk.Failed(launch.error.userMessage()))
            close()
            return@callbackFlow
        }
        launch as CliLaunchResolution.Ready

        val workspace = File(context.filesDir, "minis-sessions/$safeSessionId/workspace")
        val privateDir = File(workspace, ".leo-cli").apply { mkdirs() }
        val promptFile = File(privateDir, "prompt-${System.nanoTime()}.txt")
        val tempFile = File(privateDir, ".${promptFile.name}.tmp")
        val linuxPrompt = "/var/minis/workspace/.leo-cli/${promptFile.name}"
        try {
            tempFile.writeText(prompt)
            check(tempFile.renameTo(promptFile)) { "Unable to stage CLI prompt" }
        } catch (error: Throwable) {
            tempFile.delete()
            trySend(CliChatChunk.Failed(error.message ?: "Unable to stage CLI prompt"))
            close()
            return@callbackFlow
        }

        val decoder = CliStreamDecoder(toolId)
        val command = CliChatCommand.build(
            spec = spec,
            preference = preference,
            promptFile = linuxPrompt,
            sessionUuid = UUID.nameUUIDFromBytes(
                "leo-cli:${toolId.name}:$safeSessionId".toByteArray(StandardCharsets.UTF_8),
            ).toString(),
        )

        try {
            val result = ExecutionCoordinator.execute(
                sessionId = safeSessionId,
                command = command,
                timeout = TURN_TIMEOUT_MS,
                transientEnvironment = launch.request.environment,
                lineCallback = { line ->
                    decoder.accept(line).forEach { text ->
                        if (text.isNotEmpty()) trySend(CliChatChunk.Delta(text))
                    }
                },
            )
            val finalOutput = decoder.finalOutput.ifBlank { decoder.accumulatedText }
            if (result.exitCode == 0) {
                trySend(CliChatChunk.Completed(finalOutput))
            } else {
                val detail = decoder.failureMessage
                    .ifBlank { result.output.lineSequence().toList().takeLast(8).joinToString("\n").trim() }
                    .ifBlank { "${spec.displayName} exited with code ${result.exitCode}" }
                trySend(CliChatChunk.Failed(detail))
            }
        } catch (error: Throwable) {
            trySend(CliChatChunk.Failed(error.message ?: error.javaClass.simpleName))
        } finally {
            tempFile.delete()
            promptFile.delete()
            close()
        }
        awaitClose {
            tempFile.delete()
            promptFile.delete()
        }
    }

    companion object {
        private const val TURN_TIMEOUT_MS = 30 * 60_000L
    }
}

internal object CliChatCommand {
    fun build(
        spec: CliToolSpec,
        preference: CliToolPreference,
        promptFile: String,
        sessionUuid: String,
    ): String {
        require(promptFile.startsWith("/var/minis/workspace/.leo-cli/"))
        require(!promptFile.contains("..") && promptFile.none { it.isISOControl() })
        require(runCatching { UUID.fromString(sessionUuid) }.isSuccess)
        val binary = shellQuote(spec.binaryPath)
        val prompt = shellQuote(promptFile)
        val model = preference.model.trim().takeIf { it.isNotEmpty() }
            ?.also { require(it.length <= 200 && it.none(Char::isISOControl)) }
            ?.let { " --model ${shellQuote(it)}" }
            .orEmpty()
        val state = shellQuote("/var/minis/workspace/.leo-cli/${spec.id.name.lowercase()}.session")
        val session = shellQuote(sessionUuid)
        val body = when (spec.id) {
            CliToolId.CLAUDE -> """
                if [ -f $state ]; then
                  $binary -p --verbose --output-format stream-json --include-partial-messages --resume $session$model "${'$'}(cat $prompt)"
                else
                  $binary -p --verbose --output-format stream-json --include-partial-messages --session-id $session$model "${'$'}(cat $prompt)"
                fi
            """.trimIndent()
            CliToolId.CODEX -> """
                cd /var/minis/workspace
                if [ -f $state ]; then
                  codex_session="${'$'}(cat $state)"
                  $binary exec resume --json --skip-git-repo-check$model "${'$'}codex_session" - < $prompt
                else
                  transcript=/var/minis/workspace/.leo-cli/codex-first.jsonl
                  bash -o pipefail -c "$binary exec --json --skip-git-repo-check --sandbox workspace-write$model - < $prompt | tee /var/minis/workspace/.leo-cli/codex-first.jsonl"
                  codex_session="${'$'}(sed -n 's/.*\"thread_id\"[ ]*:[ ]*\"\([^\"]*\)\".*/\1/p' "${'$'}transcript" | head -n 1)"
                  if [ -z "${'$'}codex_session" ]; then
                    codex_session="${'$'}(sed -n 's/.*\"threadId\"[ ]*:[ ]*\"\([^\"]*\)\".*/\1/p' "${'$'}transcript" | head -n 1)"
                  fi
                  test -n "${'$'}codex_session"
                  printf '%s' "${'$'}codex_session" > $state
                  rm -f "${'$'}transcript"
                fi
            """.trimIndent()
            CliToolId.GROK -> """
                if [ -f $state ]; then
                  $binary --cwd /var/minis/workspace --output-format streaming-messages-json --include-partial-messages --resume $session$model --single "${'$'}(cat $prompt)"
                else
                  $binary --cwd /var/minis/workspace --output-format streaming-messages-json --include-partial-messages --session-id $session$model --single "${'$'}(cat $prompt)"
                fi
            """.trimIndent()
            CliToolId.CURSOR -> """
                if [ ! -s $state ]; then
                  $binary create-chat | grep -Eo '[0-9a-fA-F-]{36}' | head -n 1 > $state
                fi
                cursor_session="${'$'}(cat $state)"
                test -n "${'$'}cursor_session"
                $binary --print --output-format stream-json --stream-partial-output --workspace /var/minis/workspace --resume "${'$'}cursor_session"$model "${'$'}(cat $prompt)"
            """.trimIndent()
        }
        return """
            set -eu
            export HOME=/root
            export TMPDIR=/tmp
            export PATH="/root/.local/bin:/root/.grok/bin:${'$'}PATH"
            test -x $binary
            test -f $prompt
            mkdir -p /var/minis/workspace/.leo-cli
            (
            $body
            )
            rc=${'$'}?
            if [ "${'$'}rc" -eq 0 ] && [ ! -e $state ]; then touch $state; fi
            exit "${'$'}rc"
        """.trimIndent()
    }
}

/** Turns each CLI's JSONL dialect into monotonic text deltas. */
internal class CliStreamDecoder(private val toolId: CliToolId) {
    private val emitted = StringBuilder()
    var finalOutput: String = ""
        private set
    var failureMessage: String = ""
        private set
    val accumulatedText: String get() = emitted.toString()

    @Synchronized
    fun accept(line: String): List<String> {
        val obj = runCatching { JSONObject(line.trim()) }.getOrNull() ?: return emptyList()
        findFailure(obj)?.let { failureMessage = it }
        findFinal(obj)?.takeIf { it.isNotBlank() }?.let { finalOutput = it }

        val deltas = when (toolId) {
            CliToolId.CLAUDE -> claudeText(obj)
            CliToolId.CODEX -> codexText(obj)
            CliToolId.GROK -> messageWireText(obj)
            CliToolId.CURSOR -> cursorText(obj)
        }
        return deltas.mapNotNull(::appendMonotonic)
    }

    private fun claudeText(obj: JSONObject): List<TextPiece> {
        if (obj.optString("type") == "stream_event") {
            val event = obj.optJSONObject("event") ?: return emptyList()
            if (event.optString("type") == "content_block_delta") {
                val delta = event.optJSONObject("delta")
                val text = delta?.optString("text").orEmpty()
                if (text.isNotEmpty()) return listOf(TextPiece(text, isDelta = true))
            }
        }
        if (obj.optString("type") == "assistant") {
            return contentTexts(obj.optJSONObject("message")?.optJSONArray("content"))
                .map { TextPiece(it, isDelta = false) }
        }
        return emptyList()
    }

    private fun codexText(obj: JSONObject): List<TextPiece> {
        val type = obj.optString("type")
        val item = obj.optJSONObject("item")
        return when {
            type == "item.completed" && item?.optString("type") in setOf("agent_message", "agentMessage") ->
                listOf(TextPiece(item?.optString("text").orEmpty(), isDelta = false))
            type.endsWith(".delta") && obj.optString("delta").isNotEmpty() ->
                listOf(TextPiece(obj.optString("delta"), isDelta = true))
            else -> emptyList()
        }
    }

    private fun messageWireText(obj: JSONObject): List<TextPiece> {
        val type = obj.optString("type")
        return when (type) {
            "content_block_delta" -> {
                val text = obj.optJSONObject("delta")?.optString("text").orEmpty()
                if (text.isEmpty()) emptyList() else listOf(TextPiece(text, isDelta = true))
            }
            "assistant", "message" -> contentTexts(
                obj.optJSONObject("message")?.optJSONArray("content") ?: obj.optJSONArray("content"),
            ).map { TextPiece(it, isDelta = false) }
            else -> emptyList()
        }
    }

    private fun cursorText(obj: JSONObject): List<TextPiece> {
        val type = obj.optString("type")
        val delta = obj.optString("delta")
        if ((type.contains("delta") || type.contains("partial")) && delta.isNotEmpty()) {
            return listOf(TextPiece(delta, isDelta = true))
        }
        return messageWireText(obj)
    }

    private fun contentTexts(content: JSONArray?): List<String> {
        if (content == null) return emptyList()
        return (0 until content.length()).mapNotNull { index ->
            val block = content.optJSONObject(index) ?: return@mapNotNull null
            block.optString("text").takeIf { block.optString("type") == "text" && it.isNotEmpty() }
        }
    }

    private fun findFinal(obj: JSONObject): String? = when (obj.optString("type")) {
        "result" -> obj.optString("result")
        "turn.completed" -> obj.optString("output")
        else -> null
    }

    private fun findFailure(obj: JSONObject): String? {
        val error = obj.opt("error")
        return when (error) {
            is String -> error.takeIf { it.isNotBlank() }
            is JSONObject -> error.optString("message").takeIf { it.isNotBlank() }
            else -> obj.optString("message").takeIf {
                obj.optString("type") in setOf("error", "run.failed") && it.isNotBlank()
            }
        }
    }

    private fun appendMonotonic(piece: TextPiece): String? {
        val text = piece.text
        if (text.isEmpty()) return null
        if (piece.isDelta) {
            emitted.append(text)
            return text
        }
        val current = emitted.toString()
        return when {
            current.isEmpty() -> text.also(emitted::append)
            text.startsWith(current) -> text.removePrefix(current).takeIf { it.isNotEmpty() }?.also(emitted::append)
            current.endsWith(text) -> null
            else -> text.also(emitted::append)
        }
    }

    private data class TextPiece(val text: String, val isDelta: Boolean)
}

private fun CliLaunchError.userMessage(): String = when (this) {
    CliLaunchError.UNSUPPORTED -> "This CLI cannot use the selected LeoPhoneAgent credential."
    CliLaunchError.NO_CURRENT_MODEL -> "Configure a compatible provider or turn off LeoPhoneAgent API-key reuse."
    CliLaunchError.PROVIDER_MISMATCH -> "The selected provider does not match this CLI."
    CliLaunchError.OAUTH_NOT_EXPORTABLE -> "OAuth credentials stay private. Sign in inside this CLI instead."
    CliLaunchError.CUSTOM_ENDPOINT_UNSUPPORTED -> "Custom endpoints cannot be handed to this CLI yet."
    CliLaunchError.NO_API_KEY -> "No reusable API key is configured for this CLI."
}
