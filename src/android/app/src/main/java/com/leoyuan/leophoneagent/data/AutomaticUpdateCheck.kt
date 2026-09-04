package com.leoyuan.leophoneagent.data

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.leoyuan.leophoneagent.MainActivity
import com.leoyuan.leophoneagent.R
import java.util.concurrent.TimeUnit

/** Daily, network-gated release discovery. It never downloads or installs without a tap. */
object AutomaticUpdateCheck {
    private const val PREFS = "automatic_update_check"
    private const val ENABLED = "enabled"
    private const val NOTIFIED_VERSION = "notified_version"
    private const val UNIQUE = "leo-automatic-update-check"
    private const val CHANNEL = "app_updates"
    private const val NOTIFICATION_ID = 0x4c454f

    fun isEnabled(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ENABLED, true)

    fun setEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ENABLED, enabled).apply()
        if (enabled) enqueue(context) else WorkManager.getInstance(context).cancelUniqueWork(UNIQUE)
    }

    fun enqueue(context: Context) {
        if (!isEnabled(context)) return
        val request = PeriodicWorkRequestBuilder<AutomaticUpdateCheckWorker>(24, TimeUnit.HOURS)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .setRequiresBatteryNotLow(true)
                    .build(),
            )
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(
            UNIQUE,
            ExistingPeriodicWorkPolicy.KEEP,
            request,
        )
    }

    fun notifyIfNeeded(context: Context, update: UpdateChecker.CheckResult.UpdateAvailable) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(NOTIFIED_VERSION, null) == update.versionName) return
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED
        ) return
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return

        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL, context.getString(R.string.auto_update_channel), NotificationManager.IMPORTANCE_DEFAULT),
            )
        }
        val openUpdate = Intent(
            Intent.ACTION_VIEW,
            Uri.parse("leophoneagent://settings/about"),
            context,
            MainActivity::class.java,
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending = PendingIntent.getActivity(
            context,
            0,
            openUpdate,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher_monochrome)
            .setContentTitle(context.getString(R.string.auto_update_available_title, update.versionName))
            .setContentText(context.getString(R.string.auto_update_available_body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        prefs.edit().putString(NOTIFIED_VERSION, update.versionName).apply()
    }
}

class AutomaticUpdateCheckWorker(context: Context, params: WorkerParameters) :
    CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        if (!AutomaticUpdateCheck.isEnabled(applicationContext)) return Result.success()
        val result = UpdateChecker.check()
        if (result is UpdateChecker.CheckResult.UpdateAvailable) {
            AutomaticUpdateCheck.notifyIfNeeded(applicationContext, result)
        }
        return Result.success()
    }
}
