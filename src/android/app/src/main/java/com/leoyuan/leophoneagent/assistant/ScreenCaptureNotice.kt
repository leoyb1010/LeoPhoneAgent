package com.leoyuan.leophoneagent.assistant

import android.app.Activity
import android.os.Build
import android.widget.Toast
import androidx.annotation.RequiresApi
import com.leoyuan.leophoneagent.R
import java.util.WeakHashMap

/** API 34+ screenshot / screen-record notice. Isolated so older devices never load ScreenCaptureCallback. */
object ScreenCaptureNotice {
    fun register(activity: Activity) {
        if (Build.VERSION.SDK_INT < 34) return
        ScreenCaptureNoticeApi34.register(activity)
    }

    fun unregister(activity: Activity) {
        if (Build.VERSION.SDK_INT < 34) return
        ScreenCaptureNoticeApi34.unregister(activity)
    }
}

@RequiresApi(34)
private object ScreenCaptureNoticeApi34 {
    private val callbacks = WeakHashMap<Activity, Activity.ScreenCaptureCallback>()

    fun register(activity: Activity) {
        if (callbacks.containsKey(activity)) return
        val callback = Activity.ScreenCaptureCallback {
            Toast.makeText(
                activity,
                activity.getString(R.string.screen_capture_notice),
                Toast.LENGTH_SHORT,
            ).show()
        }
        activity.registerScreenCaptureCallback(activity.mainExecutor, callback)
        callbacks[activity] = callback
    }

    fun unregister(activity: Activity) {
        val callback = callbacks.remove(activity) ?: return
        activity.unregisterScreenCaptureCallback(callback)
    }
}
