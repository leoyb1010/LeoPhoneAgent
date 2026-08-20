package com.leoyuan.leophoneagent.relay

import android.content.Context
import android.util.Log
import com.leoyuan.leophoneagent.data.model.ThinkingLevel
import com.leoyuan.leophoneagent.debug.HeadlessChatRunner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Bridges remote `minis` harness turns onto the existing Android agent loop. */
class AndroidMinisSessionEngine(private val context: Context) : MinisSessionEngine {

    /**
     * harness sessionId → 本地 chatId。
     *
     * why 实例字段而不是 companion 静态表：`RelayBodyService.restart` 每次配置
     * 变化都 new 一个新的 router + 新的 engine，静态表会把上一代 router 的映射
     * 永久留下来（旧 harness id 指向早已被 forget 的 chatId），既泄漏又可能让
     * 新 router 误命中旧 chat。跟着 engine 实例走，router 换代即自然清空。
     */
    private val boundIds = java.util.concurrent.ConcurrentHashMap<String, String>()

    override fun runTurn(sessionId: String, text: String, thinking: String?): Flow<EngineChunk> =
        callbackFlow {
            val job = launch {
                val existing = boundIds[sessionId]
                val chatId = existing ?: HeadlessChatRunner.ensureSession(
                    context = context,
                    // P2：relay 建的会话过去写死 source="debug"，在会话列表里和
                    // 真正的调试会话混成一堆。给它自己的来源标签。
                    source = SOURCE_RELAY,
                ).also { created ->
                    boundIds[sessionId] = created
                    HeadlessChatRunner.applyModelOverride(context, created, null, null)
                }
                val result = HeadlessChatRunner.streamPrompt(
                    context = context,
                    sessionId = chatId,
                    text = text,
                    thinkingLevel = parseThinking(thinking),
                    // delta 仍然用 trySend：onDelta 是同步回调（跑在
                    // HeadlessChatRunner 的 Default 收集协程上），拿不到挂起点。
                    // 缓冲已放大到 DELTA_BUFFER，溢出时至少留下日志而不是完全静默。
                    onDelta = { delta ->
                        if (trySend(EngineChunk.Delta(delta)).isFailure) {
                            Log.w(TAG, "delta dropped (buffer full) session=$sessionId len=${delta.length}")
                        }
                    },
                )
                // why 终态用挂起的 send()：原来这里也是 trySend。callbackFlow 默认
                // BUFFERED(64)，delta 高频回调很容易把缓冲打满；一旦丢掉的是
                // Completed/Failed，紧接着的 close() 会让这一轮**一个终态事件都没
                // 有**，router 侧 session.status 永远停在 running、控制端一直等，
                // 该会话也永远进不了可淘汰集合。send() 会等到有位置再投递，
                // 只有整条流已被取消时才抛 CancellationException（那种情况下
                // 终态本来就不该发）。
                val terminal = when {
                    result.status == "Error" -> EngineChunk.Failed(
                        withForegroundServiceHint(result.responseText ?: "minis turn failed"),
                    )
                    // 注：`result.timedOut` 目前仍然走 Completed 分支（与改动前
                    // 一致）。把超时改成 run.failed 会丢掉已经产出的部分文本，
                    // 属于本次 review 之外的行为变更，故不动。
                    else -> EngineChunk.Completed(result.responseText.orEmpty())
                }
                send(terminal)
                close()
            }
            awaitClose { job.cancel() }
        }.buffer(DELTA_BUFFER)

    /**
     * why suspend + withContext(Main)：原来是
     * `runBlocking { HeadlessChatRunner.cancel(...) }`，而 cancel 内部是
     * `withContext(Dispatchers.Main)`。调用点在 OkHttp WS reader 线程上，等于
     * 远程发一次 stop/steer 就把 relay 的读线程钉死到主线程空闲为止。
     */
    override suspend fun stop(sessionId: String) {
        val chatId = boundIds[sessionId] ?: sessionId
        HeadlessChatRunner.cancel(context, chatId)
    }

    override suspend fun release(sessionId: String) {
        val chatId = boundIds.remove(sessionId) ?: return
        HeadlessChatRunner.cancel(context, chatId)
        // why 显式切主线程：forgetAndRelease 会走到 ViewModelStore.clear() →
        // ChatViewModel.onCleared()。其余三个调用点都在主线程；只有这里过去跑
        // 在 router 的淘汰线程上，等于让 ViewModel 的清理逻辑在后台线程执行
        // （它里面会碰 StateFlow / UI 侧对象）。
        withContext(Dispatchers.Main) {
            HeadlessChatRunner.forgetAndRelease(chatId)
        }
    }

    /**
     * review P0#1 的后半段：把"前台服务被系统拒绝"这件事回到 relay 事件流里。
     *
     * 这里**只**在这一轮本来就失败/超时时追加提示，而不是一探到降级就伪造一条
     * `run.failed` —— 前台服务起不来时这一轮往往还能正常跑完，提前报失败会让
     * 控制端丢掉一次真实的输出。真正的崩溃已经在
     * [AgentForegroundService.startService] 里被吞掉了；剩下的价值是让远端知道
     * "这台手机现在没有前台服务保命，任务是被系统掐掉的，去开电池优化豁免"。
     */
    private fun withForegroundServiceHint(message: String): String =
        if (com.leoyuan.leophoneagent.service.AgentForegroundService.startDegraded.value) {
            "$message (Android refused to start this phone's foreground service — " +
                "grant \"ignore battery optimisations\" so background turns are not killed)"
        } else {
            message
        }

    companion object {
        private const val TAG = "AndroidMinisEngine"

        /** relay 会话在会话列表里的来源标签。 */
        const val SOURCE_RELAY = "relay"

        /**
         * callbackFlow 的融合缓冲容量。默认 BUFFERED(64) 对流式 delta 太小；
         * router 的 collect 里每条事件都要过一次会话记账 + WebSocket 写，
         * 生产端比消费端快得多。
         */
        private const val DELTA_BUFFER = 512

        fun parseThinking(raw: String?): ThinkingLevel? {
            if (raw.isNullOrBlank()) return null
            return ThinkingLevel.entries.firstOrNull {
                it.name.equals(raw, ignoreCase = true) || it.displayName.equals(raw, ignoreCase = true)
            }
        }
    }
}
