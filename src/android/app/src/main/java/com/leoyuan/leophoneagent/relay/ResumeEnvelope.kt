package com.leoyuan.leophoneagent.relay

import org.json.JSONObject

data class ResumeEnvelope(
    val status: String,
    val after: Int,
    val minAfter: Int,
) {
    val isGap: Boolean get() = status == "gap"
}

object ResumeEnvelopes {
    fun of(after: Int, minAfter: Int): ResumeEnvelope {
        val safeAfter = after.coerceAtLeast(0)
        val safeMin = minAfter.coerceAtLeast(0)
        return if (safeAfter < safeMin) {
            ResumeEnvelope("gap", safeAfter, safeMin)
        } else {
            ResumeEnvelope("ok", safeAfter, safeMin)
        }
    }

    fun parse(data: String): ResumeEnvelope? {
        val obj = runCatching { JSONObject(data) }.getOrNull() ?: return null
        val kind = obj.optString("type") == "resume" || obj.optString("event") == "resume"
        if (!kind) return null
        val status = obj.optString("status")
        if (status != "ok" && status != "gap") return null
        return of(obj.optInt("after", 0), obj.optInt("min_after", 0))
    }

    fun nextAfter(lastSeq: Int, envelope: ResumeEnvelope): Int =
        if (envelope.isGap) maxOf(lastSeq, envelope.minAfter) else lastSeq

    fun toJson(envelope: ResumeEnvelope): JSONObject =
        JSONObject()
            .put("type", "resume")
            .put("event", "resume")
            .put("status", envelope.status)
            .put("after", envelope.after)
            .put("min_after", envelope.minAfter)
}
