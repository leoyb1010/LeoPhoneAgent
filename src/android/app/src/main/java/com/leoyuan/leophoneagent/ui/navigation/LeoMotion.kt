package com.leoyuan.leophoneagent.ui.navigation

import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

/**
 * Existing Material 3 emphasized tokens already used by [AppNavigation]
 * NavHost. Extracted so fold/pane morphs reuse the same language.
 *
 * Source: m3.material.io/styles/motion/easing-and-duration/tokens-specs
 */
object LeoMotion {
    val EmphasizedDecelerate = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1.0f)
    val EmphasizedAccelerate = CubicBezierEasing(0.3f, 0.0f, 0.8f, 0.15f)

    const val EnterMs: Int = 300
    const val ExitMs: Int = 200
    const val LayoutMorphMs: Int = 450
}

@Composable
fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current
    return try {
        val resolver = context.contentResolver
        val transition = Settings.Global.getFloat(resolver, Settings.Global.TRANSITION_ANIMATION_SCALE, 1f)
        val animator = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        transition == 0f || animator == 0f
    } catch (_: Throwable) {
        false
    }
}
