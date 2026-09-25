package com.leoyuan.leophoneagent.provider

import com.leoyuan.leophoneagent.data.model.AgentToolDefinition
import org.json.JSONObject

/**
 * JSON repair for malformed tool calls (T-tool-json-repair b2c4f8a6).
 *
 * Mirrors the iOS implementation in AIChatViewModel+ToolPreflight.swift (repairToolArgs).
 * Operates on the already-parsed [JSONObject] that the streaming provider surfaced.
 *
 * Two strategies, applied in order, each gated on actually being needed:
 *
 * 1. Type coercion — for each required field present but not a String, coerce via
 *    `toString()` so the downstream blank-string preflight check has something usable.
 * 2. Fuzzy field-name match — for each missing required field, look for a sibling key
 *    whose Levenshtein distance is exactly 1 and rename it. Catches one-off typos
 *    like `comand` → `command`.
 *
 * Arguments cut off mid-stream (output limit, dropped connection) are never patched up:
 * closing the cut string turned half a `file_write` into a valid call that overwrote the
 * file with the fragment, and half a shell command into one that ran. Preflight rejects
 * the empty args and the model sends the call again.
 *
 * The repaired [JSONObject] shadows the original at the preflight call site; the
 * caller logs the returned repair tags at WARNING level when non-empty.
 */
object ToolJsonRepair {

    /**
     * Mutates [args] in-place and returns the list of repair strategy tags
     * that fired (empty when nothing changed). Caller is responsible for
     * logging the tags at WARNING level when non-empty.
     */
    fun repair(
        toolName: String,
        args: JSONObject,
        tools: List<AgentToolDefinition>,
    ): List<String> {
        val toolDef = tools.firstOrNull { it.name == toolName }
            ?: return emptyList()

        val repairs = mutableListOf<String>()

        // Strategy 1: type coercion on required fields.
        for (field in toolDef.required) {
            if (!args.has(field)) continue
            val raw = args.opt(field) ?: continue
            if (raw is String) continue
            if (raw === JSONObject.NULL) continue
            val coerced = raw.toString()
            if (coerced.trim().isNotEmpty()) {
                args.put(field, coerced)
                repairs.add("type-coerce:$field")
            }
        }

        // Strategy 2: fuzzy field-name match for missing required fields. Skip
        // sibling keys that are themselves a recognized schema field — don't
        // steal a sibling that the tool helper would have read directly.
        val schemaFields = toolDef.parameters.keys
        for (field in toolDef.required) {
            if (args.has(field)) continue
            val keys = args.keys().asSequence().toList()
            val candidate = keys.firstOrNull { key ->
                key !in schemaFields && levenshteinAtMostOne(key, field)
            } ?: continue
            args.put(field, args.opt(candidate))
            args.remove(candidate)
            repairs.add("fuzzy:$candidate->$field")
        }

        return repairs
    }

    /**
     * `true` iff Levenshtein edit distance between [a] and [b] is exactly 1
     * (case-insensitive). Tight short-circuit — we don't care about distance > 1.
     */
    private fun levenshteinAtMostOne(a: String, b: String): Boolean {
        val al = a.lowercase()
        val bl = b.lowercase()
        if (al == bl) return false // distance 0 = same key, not a repair candidate
        val diff = al.length - bl.length
        if (diff > 1 || diff < -1) return false
        if (al.length == bl.length) {
            var mismatches = 0
            for (i in al.indices) {
                if (al[i] != bl[i]) {
                    mismatches += 1
                    if (mismatches > 1) return false
                }
            }
            return mismatches == 1
        }
        val longer = if (al.length > bl.length) al else bl
        val shorter = if (al.length > bl.length) bl else al
        var i = 0
        var j = 0
        var skipped = false
        while (i < longer.length && j < shorter.length) {
            if (longer[i] == shorter[j]) {
                i += 1; j += 1
            } else if (!skipped) {
                i += 1; skipped = true
            } else {
                return false
            }
        }
        return true
    }
}

