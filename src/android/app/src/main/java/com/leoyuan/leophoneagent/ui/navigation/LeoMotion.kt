package com.leoyuan.leophoneagent.ui.navigation

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.compose.currentStateAsState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.stateIn

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
    val context = LocalContext.current.applicationContext
    val flow = remember(context) { MotionSettings.observe(context) }
    val reduced by flow.collectAsStateWithLifecycle()
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateAsState()
    return reduced || !lifecycleState.isAtLeast(Lifecycle.State.STARTED)
}

/** One settings observer shared by all visible indicators, never one observer per message. */
private object MotionSettings {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var state: StateFlow<Boolean>? = null

    fun observe(context: Context): StateFlow<Boolean> {
        state?.let { return it }
        val resolver = context.contentResolver
        fun read(): Boolean = runCatching {
            listOf(
                Settings.Global.TRANSITION_ANIMATION_SCALE,
                Settings.Global.ANIMATOR_DURATION_SCALE,
                Settings.Global.WINDOW_ANIMATION_SCALE,
            ).any { Settings.Global.getFloat(resolver, it, 1f) == 0f }
        }.getOrDefault(false)
        return callbackFlow {
            val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
                override fun onChange(selfChange: Boolean) { trySend(read()) }
            }
            val names = listOf(
                Settings.Global.TRANSITION_ANIMATION_SCALE,
                Settings.Global.ANIMATOR_DURATION_SCALE,
                Settings.Global.WINDOW_ANIMATION_SCALE,
            )
            try {
                names.forEach { resolver.registerContentObserver(Settings.Global.getUriFor(it), false, observer) }
                trySend(read())
                awaitClose { resolver.unregisterContentObserver(observer) }
            } catch (_: SecurityException) {
                resolver.unregisterContentObserver(observer)
                trySend(read())
                close()
            }
        }.distinctUntilChanged().stateIn(
            scope,
            SharingStarted.WhileSubscribed(stopTimeoutMillis = 0),
            read(),
        ).also { state = it }
    }
}
