package com.leoyuan.leophoneagent.ui.navigation

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.produceState
import androidx.compose.ui.platform.LocalContext
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import androidx.window.layout.WindowLayoutInfo

/**
 * Hinge posture used by the chat workspace. Values are window-feature
 * derived, never device-model names.
 *
 *  * [NONE] — no fold feature, or the hinge is FLAT.
 *  * [TABLETOP] — HALF_OPENED with a horizontal hinge (top/bottom).
 *  * [BOOK] — HALF_OPENED with a vertical hinge (left/right).
 */
enum class FoldPosture {
    NONE,
    TABLETOP,
    BOOK,
}

/**
 * Combines the existing 600×480 dp window-size rule with hinge posture.
 *
 * Cover / compact / split-screen / shallow landscape stay one pane via
 * [shouldUseFoldableTwoPane]. A HALF_OPENED tabletop hinge cuts horizontally
 * through both columns of the current left-right 50/50 (composer + message
 * list), so those windows stay single-pane even when they are wide enough.
 * Book-mode (vertical hinge) keeps two panes so the seam can sit on the hinge.
 */
internal fun shouldUseTwoPaneWorkspace(
    widthDp: Float,
    heightDp: Float,
    posture: FoldPosture,
): Boolean {
    if (!shouldUseFoldableTwoPane(widthDp, heightDp)) return false
    if (posture == FoldPosture.TABLETOP) return false
    return true
}

/**
 * Pure mapper so JVM tests can cover HALF_OPENED / tabletop / book without
 * constructing a [FoldingFeature].
 */
internal fun foldPostureOf(halfOpened: Boolean, horizontalHinge: Boolean): FoldPosture {
    if (!halfOpened) return FoldPosture.NONE
    return if (horizontalHinge) FoldPosture.TABLETOP else FoldPosture.BOOK
}

/**
 * Compose [LocalContext] is almost never a raw [Activity] — it is a
 * [ContextThemeWrapper] / [ContextWrapper]. A direct `as? Activity` cast
 * therefore misses the host and leaves fold posture stuck at [FoldPosture.NONE].
 */
internal fun Context.findActivity(): Activity? {
    var current: Context? = this
    while (current != null) {
        if (current is Activity) return current
        current = (current as? ContextWrapper)?.baseContext
    }
    return null
}

internal fun foldPostureFromLayoutInfo(info: WindowLayoutInfo?): FoldPosture {
    val feature = info?.displayFeatures?.filterIsInstance<FoldingFeature>()?.firstOrNull()
        ?: return FoldPosture.NONE
    return foldPostureOf(
        halfOpened = feature.state == FoldingFeature.State.HALF_OPENED,
        horizontalHinge = feature.orientation == FoldingFeature.Orientation.HORIZONTAL,
    )
}

@Composable
internal fun rememberFoldPosture(): State<FoldPosture> {
    val context = LocalContext.current
    return produceState(initialValue = FoldPosture.NONE, context) {
        val activity = context.findActivity()
        if (activity == null) {
            value = FoldPosture.NONE
            return@produceState
        }
        WindowInfoTracker.getOrCreate(activity)
            .windowLayoutInfo(activity)
            .collect { value = foldPostureFromLayoutInfo(it) }
    }
}
