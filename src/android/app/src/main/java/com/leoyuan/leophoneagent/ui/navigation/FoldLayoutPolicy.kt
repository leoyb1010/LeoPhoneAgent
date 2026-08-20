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
 *  * [UNKNOWN] — first WindowLayoutInfo has not arrived; treat as single-pane.
 *  * [NONE] — no fold feature, or the hinge is FLAT.
 *  * [TABLETOP] — HALF_OPENED with a horizontal hinge (top/bottom).
 *  * [BOOK] — HALF_OPENED with a vertical hinge (left/right).
 */
enum class FoldPosture {
    UNKNOWN,
    NONE,
    TABLETOP,
    BOOK,
}

enum class WorkspaceArrangement {
    SINGLE,
    LEFT_RIGHT,
    TOP_BOTTOM,
}

data class HingeBand(
    val startFraction: Float,
    val endFraction: Float,
) {
    val midFraction: Float get() = (startFraction + endFraction) / 2f
}

data class WorkspaceLayoutDecision(
    val arrangement: WorkspaceArrangement,
    val hinge: HingeBand?,
)

data class FoldObservation(
    val posture: FoldPosture,
    val hinge: HingeBand? = null,
) {
    companion object {
        val Unknown = FoldObservation(FoldPosture.UNKNOWN)
    }
}

/**
 * Combines the 600×480 dp window-size rule with hinge posture.
 *
 * Unknown posture stays single-pane so tabletop cannot flash left-right
 * 50/50 for one frame. Tabletop is a vertical split (messages above the
 * hinge, composer below). Book / flat use left-right when the window is
 * large enough. Large font on a narrow half-pane falls back to single.
 */
internal fun workspaceLayoutOf(
    widthDp: Float,
    heightDp: Float,
    posture: FoldPosture,
    hinge: HingeBand? = null,
    fontScale: Float = 1f,
): WorkspaceLayoutDecision {
    if (posture == FoldPosture.UNKNOWN) {
        return WorkspaceLayoutDecision(WorkspaceArrangement.SINGLE, null)
    }
    if (!shouldUseFoldableTwoPane(widthDp, heightDp)) {
        return WorkspaceLayoutDecision(WorkspaceArrangement.SINGLE, null)
    }
    if (posture == FoldPosture.TABLETOP) {
        val band = hinge ?: HingeBand(0.5f, 0.5f)
        return WorkspaceLayoutDecision(WorkspaceArrangement.TOP_BOTTOM, band)
    }
    if (shouldFallbackFromCrampedTwoPane(widthDp, heightDp, fontScale)) {
        return WorkspaceLayoutDecision(WorkspaceArrangement.SINGLE, null)
    }
    return WorkspaceLayoutDecision(WorkspaceArrangement.LEFT_RIGHT, hinge)
}

internal fun shouldFallbackFromCrampedTwoPane(
    widthDp: Float,
    heightDp: Float,
    fontScale: Float,
): Boolean {
    val chatPaneWidth = widthDp / 2f
    val composerMinDp = 72f * fontScale
    if (fontScale >= 1.3f && chatPaneWidth < 360f) return true
    if (composerMinDp > heightDp * 0.4f) return true
    return false
}

internal fun foldPostureOf(halfOpened: Boolean, horizontalHinge: Boolean): FoldPosture {
    if (!halfOpened) return FoldPosture.NONE
    return if (horizontalHinge) FoldPosture.TABLETOP else FoldPosture.BOOK
}

internal fun hingeBandFromPixels(startPx: Int, endPx: Int, totalPx: Int): HingeBand? {
    if (totalPx <= 0) return null
    val start = (startPx.toFloat() / totalPx).coerceIn(0f, 1f)
    val end = (endPx.toFloat() / totalPx).coerceIn(0f, 1f)
    if (end < start) return null
    return HingeBand(start, end)
}

/**
 * Compose [LocalContext] is almost never a raw [Activity] — it is a
 * [ContextThemeWrapper] / [ContextWrapper]. A direct `as? Activity` cast
 * therefore misses the host and leaves fold posture stuck at unknown/none.
 */
internal fun Context.findActivity(): Activity? {
    var current: Context? = this
    while (current != null) {
        if (current is Activity) return current
        current = (current as? ContextWrapper)?.baseContext
    }
    return null
}

internal fun foldObservationFromLayoutInfo(
    info: WindowLayoutInfo?,
    windowWidthPx: Int,
    windowHeightPx: Int,
): FoldObservation {
    if (info == null) return FoldObservation.Unknown
    val feature = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull()
    if (feature == null) {
        return FoldObservation(FoldPosture.NONE, hinge = null)
    }
    val halfOpened = feature.state == FoldingFeature.State.HALF_OPENED
    val horizontal = feature.orientation == FoldingFeature.Orientation.HORIZONTAL
    val posture = foldPostureOf(halfOpened, horizontal)
    val bounds = feature.bounds
    val hinge = if (horizontal) {
        hingeBandFromPixels(bounds.top, bounds.bottom, windowHeightPx)
    } else {
        hingeBandFromPixels(bounds.left, bounds.right, windowWidthPx)
    }
    return FoldObservation(posture, hinge)
}

@Composable
internal fun rememberFoldObservation(): State<FoldObservation> {
    val context = LocalContext.current
    return produceState(initialValue = FoldObservation.Unknown, context) {
        val activity = context.findActivity()
        if (activity == null) {
            value = FoldObservation.Unknown
            return@produceState
        }
        WindowInfoTracker.getOrCreate(activity)
            .windowLayoutInfo(activity)
            .collect { info ->
                val decor = activity.window?.decorView
                val w = decor?.width ?: 0
                val h = decor?.height ?: 0
                value = foldObservationFromLayoutInfo(info, w, h)
            }
    }
}
