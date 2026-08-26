package com.leoyuan.leophoneagent.ui.settings

/** Case-insensitive settings row match. Empty query shows every row. */
object SettingsSearch {
    fun matches(query: String, vararg fields: String?): Boolean {
        val q = query.trim()
        if (q.isEmpty()) return true
        val needle = q.lowercase()
        return fields.any { it?.lowercase()?.contains(needle) == true }
    }
}
