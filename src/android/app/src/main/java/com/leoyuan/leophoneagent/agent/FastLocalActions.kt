package com.leoyuan.leophoneagent.agent

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.service.SessionTaskStatus

/**
 * Offline native actions for T7. Regex routing lives in [ActionRouter];
 * this object only flips the torch and parks a todo notice.
 *
 * ponytail: no GGUF, no second loop. Ceiling is OEM torch quirks —
 * setTorchMode throwing falls through to the existing agent path.
 */
object FastLocalActions {
    private const val CHANNEL = "leo_todos"

    fun setTorch(context: Context, on: Boolean): Boolean {
        val cm = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: return false
        val id = cm.cameraIdList.firstOrNull { cam ->
            cm.getCameraCharacteristics(cam).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        } ?: return false
        return try {
            cm.setTorchMode(id, on)
            SessionTaskStatus.setTorchOn(on)
            true
        } catch (_: Exception) {
            false
        }
    }

    fun addTodo(context: Context, title: String): Boolean {
        val text = title.ifBlank { "待办" }
        SessionTaskStatus.setLastTodo(text)
        ensureChannel(context)
        val note = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("待办")
            .setContentText(text)
            .setAutoCancel(true)
            .build()
        val nm = NotificationManagerCompat.from(context)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !nm.areNotificationsEnabled()) {
            return true
        }
        try {
            nm.notify(text.hashCode(), note)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS denied — todo is still parked in SessionTaskStatus.
        }
        return true
    }

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL) != null) return
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, "待办", NotificationManager.IMPORTANCE_DEFAULT),
        )
    }
}
