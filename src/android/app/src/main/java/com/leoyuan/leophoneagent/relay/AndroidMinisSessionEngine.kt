package com.leoyuan.leophoneagent.relay

import android.content.Context
import com.leoyuan.leophoneagent.data.model.ThinkingLevel
import com.leoyuan.leophoneagent.debug.HeadlessChatRunner
import com.leoyuan.leophoneagent.ui.chat.ChatViewModelStore
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch

/** Bridges remote `minis` harness turns onto the existing Android agent loop. */
class AndroidMinisSessionEngine(private val context: Context) : MinisSessionEngine {
    override fun runTurn(sessionId: String, text: String, thinking: String?): Flow<EngineChunk> =
        callbackFlow {
            val job = launch {
                val existing = boundIds[sessionId]
                val chatId = existing ?: HeadlessChatRunner.ensureSession(context).also { created ->
                    boundIds[sessionId] = created
                    HeadlessChatRunner.applyModelOverride(context, created, null, null)
                }
                val result = HeadlessChatRunner.streamPrompt(
                    context = context,
                    sessionId = chatId,
                    text = text,
                    thinkingLevel = parseThinking(thinking),
                    onDelta = { delta -> trySend(EngineChunk.Delta(delta)) },
                )
                when {
                    result.status == "Error" -> trySend(
                        EngineChunk.Failed(result.responseText ?: "minis turn failed"),
                    )
                    else -> trySend(EngineChunk.Completed(result.responseText.orEmpty()))
                }
                close()
            }
            awaitClose { job.cancel() }
        }

    override fun stop(sessionId: String) {
        val chatId = boundIds[sessionId] ?: sessionId
        kotlinx.coroutines.runBlocking {
            HeadlessChatRunner.cancel(context, chatId)
        }
    }

    override fun release(sessionId: String) {
        val chatId = boundIds.remove(sessionId) ?: return
        kotlinx.coroutines.runBlocking { HeadlessChatRunner.cancel(context, chatId) }
        HeadlessChatRunner.forget(chatId)
        ChatViewModelStore.release(chatId)
    }

    companion object {
        private val boundIds = java.util.concurrent.ConcurrentHashMap<String, String>()

        fun parseThinking(raw: String?): ThinkingLevel? {
            if (raw.isNullOrBlank()) return null
            return ThinkingLevel.entries.firstOrNull {
                it.name.equals(raw, ignoreCase = true) || it.displayName.equals(raw, ignoreCase = true)
            }
        }
    }
}
