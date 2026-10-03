package com.leoyuan.leophoneagent.ui.chat

/** Pure display rules; model execution, routing, defaults and persistence keep their existing owners. */
internal fun modelPickerMatches(text: String, query: String): Boolean {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return true
    val t = text.lowercase()
    if (t.contains(q)) return true
    var index = 0
    for (character in q) {
        val found = t.indexOf(character, index)
        if (found < 0) return false
        index = found + 1
    }
    return true
}

internal fun modelGroupPreviewEntryId(
    memberEntryIds: List<String>,
    availableEntryIds: Set<String>,
    isSelected: Boolean,
    activeEntryId: String?,
): String? {
    // 当前组展示实际正在使用的模型，不能在用户选了第二项或回退后仍写第一项。
    // 配置在会话期间变更时，现有 active entry 仍是运行态；这里只展示，不重写路由。
    if (isSelected && activeEntryId != null && activeEntryId in availableEntryIds) {
        return activeEntryId
    }
    return memberEntryIds.firstOrNull { it in availableEntryIds }
}

internal fun isActiveModelGroupEntry(
    groupId: String,
    selectedGroupId: String?,
    entryId: String,
    activeEntryId: String?,
): Boolean = groupId == selectedGroupId && entryId == activeEntryId

internal fun isModelProviderCollapsed(
    providerId: String,
    collapsedProviderIds: Set<String>,
    query: String,
): Boolean = query.isBlank() && providerId in collapsedProviderIds
