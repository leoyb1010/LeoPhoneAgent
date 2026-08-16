package com.leoyuan.leophoneagent.task

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * Device-local persisted Agent run state. Mirrors iOS `agent_run_state`:
 * leftover non-terminal runs become [WAITING_USER] on the next process
 * start and never auto-resume.
 */
enum class AgentRunPhase {
    IDLE,
    RUNNING,
    PAUSED,
    WAITING_USER,
    COMPLETED,
    FAILED,
    ;

    val isTerminal: Boolean
        get() = this == COMPLETED || this == FAILED || this == IDLE
}

data class AgentRunRecord(
    val sessionId: String,
    val phase: AgentRunPhase,
    val updatedAt: Long,
    val reason: String? = null,
    val title: String? = null,
) {
    val isResumable: Boolean
        get() = phase == AgentRunPhase.WAITING_USER || phase == AgentRunPhase.PAUSED
}

object AgentRunRecovery {
    const val REASON_UNEXPECTED_TERMINATION = "unexpected_termination"
    const val REASON_USER_PAUSE = "user_pause"
    const val REASON_COMPLETED = "completed"
    const val REASON_FAILED = "failed"

    fun recover(records: List<AgentRunRecord>, now: Long): List<AgentRunRecord> =
        records.map { rec ->
            if (rec.phase.isTerminal) rec
            else rec.copy(
                phase = AgentRunPhase.WAITING_USER,
                reason = REASON_UNEXPECTED_TERMINATION,
                updatedAt = now,
            )
        }

    fun surfaceState(record: AgentRunRecord?): TaskSurfaceState = when (record?.phase) {
        null, AgentRunPhase.IDLE -> TaskSurfaceState.IDLE
        AgentRunPhase.RUNNING -> TaskSurfaceState.RUNNING
        AgentRunPhase.PAUSED -> TaskSurfaceState.PAUSED
        AgentRunPhase.WAITING_USER -> TaskSurfaceState.NEEDS_ATTENTION
        AgentRunPhase.COMPLETED -> TaskSurfaceState.COMPLETED
        AgentRunPhase.FAILED -> TaskSurfaceState.NEEDS_ATTENTION
    }
}

enum class TaskSurfaceState {
    IDLE,
    RUNNING,
    PAUSED,
    COMPLETED,
    NEEDS_ATTENTION,
}

object AgentRunStore {
    private const val PREFS = "agent_run_store"
    private const val KEY_RUNS = "runs_json"
    private const val KEY_LAST_SESSION = "last_session_id"
    private const val MAX_RECORDS = 32

    @Volatile
    private var prefs: SharedPreferences? = null

    fun init(context: Context) {
        if (prefs != null) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    fun recoverInterrupted(now: Long = System.currentTimeMillis()): List<AgentRunRecord> {
        val recovered = AgentRunRecovery.recover(all(), now)
        persist(recovered)
        return recovered.filter { it.phase == AgentRunPhase.WAITING_USER }
    }

    fun markRunning(sessionId: String, title: String? = null) {
        upsert(
            AgentRunRecord(
                sessionId = sessionId,
                phase = AgentRunPhase.RUNNING,
                updatedAt = System.currentTimeMillis(),
                title = title,
            ),
        )
        rememberLastSession(sessionId)
    }

    fun markWaitingUser(sessionId: String, reason: String = AgentRunRecovery.REASON_USER_PAUSE) {
        upsert(
            current(sessionId)?.copy(
                phase = AgentRunPhase.WAITING_USER,
                reason = reason,
                updatedAt = System.currentTimeMillis(),
            ) ?: AgentRunRecord(
                sessionId = sessionId,
                phase = AgentRunPhase.WAITING_USER,
                updatedAt = System.currentTimeMillis(),
                reason = reason,
            ),
        )
        rememberLastSession(sessionId)
    }

    fun markCompleted(sessionId: String) {
        upsert(
            current(sessionId)?.copy(
                phase = AgentRunPhase.COMPLETED,
                reason = AgentRunRecovery.REASON_COMPLETED,
                updatedAt = System.currentTimeMillis(),
            ) ?: AgentRunRecord(
                sessionId = sessionId,
                phase = AgentRunPhase.COMPLETED,
                updatedAt = System.currentTimeMillis(),
                reason = AgentRunRecovery.REASON_COMPLETED,
            ),
        )
        rememberLastSession(sessionId)
    }

    fun markFailed(sessionId: String) {
        upsert(
            current(sessionId)?.copy(
                phase = AgentRunPhase.FAILED,
                reason = AgentRunRecovery.REASON_FAILED,
                updatedAt = System.currentTimeMillis(),
            ) ?: AgentRunRecord(
                sessionId = sessionId,
                phase = AgentRunPhase.FAILED,
                updatedAt = System.currentTimeMillis(),
                reason = AgentRunRecovery.REASON_FAILED,
            ),
        )
        rememberLastSession(sessionId)
    }

    fun current(sessionId: String): AgentRunRecord? = all().firstOrNull { it.sessionId == sessionId }

    fun latest(): AgentRunRecord? = all().maxByOrNull { it.updatedAt }

    fun lastSessionId(): String? =
        prefs?.getString(KEY_LAST_SESSION, null)?.ifBlank { null }
            ?: latest()?.sessionId

    fun rememberLastSession(sessionId: String) {
        if (sessionId.startsWith("__new__")) return
        prefs?.edit()?.putString(KEY_LAST_SESSION, sessionId)?.apply()
    }

    fun waitingSessionIds(): Set<String> =
        all().filter { it.phase == AgentRunPhase.WAITING_USER }.map { it.sessionId }.toSet()

    fun all(): List<AgentRunRecord> {
        val raw = prefs?.getString(KEY_RUNS, null) ?: return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            buildList {
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    val sid = o.optString("sessionId").ifBlank { null } ?: continue
                    val phase = runCatching {
                        AgentRunPhase.valueOf(o.optString("phase"))
                    }.getOrDefault(AgentRunPhase.IDLE)
                    add(
                        AgentRunRecord(
                            sessionId = sid,
                            phase = phase,
                            updatedAt = o.optLong("updatedAt"),
                            reason = o.optString("reason").takeIf { it.isNotBlank() },
                            title = o.optString("title").takeIf { it.isNotBlank() },
                        ),
                    )
                }
            }
        }.getOrElse { emptyList() }
    }

    private fun upsert(record: AgentRunRecord) {
        val next = (listOf(record) + all().filter { it.sessionId != record.sessionId })
            .sortedByDescending { it.updatedAt }
            .take(MAX_RECORDS)
        persist(next)
    }

    private fun persist(records: List<AgentRunRecord>) {
        val arr = JSONArray()
        records.forEach { rec ->
            arr.put(
                JSONObject().apply {
                    put("sessionId", rec.sessionId)
                    put("phase", rec.phase.name)
                    put("updatedAt", rec.updatedAt)
                    rec.reason?.let { put("reason", it) }
                    rec.title?.let { put("title", it) }
                },
            )
        }
        prefs?.edit()?.putString(KEY_RUNS, arr.toString())?.apply()
    }
}
