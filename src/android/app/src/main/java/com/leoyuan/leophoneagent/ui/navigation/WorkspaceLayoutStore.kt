package com.leoyuan.leophoneagent.ui.navigation

/**
 * Process-level snapshot of the live chat window so `android-device` can
 * report fold posture and size without guessing cover vs inner.
 */
object WorkspaceLayoutStore {
    @Volatile var postureName: String = "unknown"
        private set
    @Volatile var widthDp: Float = 0f
        private set
    @Volatile var heightDp: Float = 0f
        private set
    @Volatile var twoPane: Boolean = false
        private set
    @Volatile var arrangementName: String = "single"
        private set

    @Synchronized
    fun update(
        posture: FoldPosture,
        widthDp: Float,
        heightDp: Float,
        decision: WorkspaceLayoutDecision,
    ) {
        postureName = when (posture) {
            FoldPosture.UNKNOWN -> "unknown"
            FoldPosture.NONE -> "none"
            FoldPosture.TABLETOP -> "tabletop"
            FoldPosture.BOOK -> "book"
        }
        this.widthDp = widthDp
        this.heightDp = heightDp
        twoPane = decision.arrangement == WorkspaceArrangement.LEFT_RIGHT
        arrangementName = when (decision.arrangement) {
            WorkspaceArrangement.SINGLE -> "single"
            WorkspaceArrangement.LEFT_RIGHT -> "left_right"
            WorkspaceArrangement.TOP_BOTTOM -> "top_bottom"
        }
    }
}
