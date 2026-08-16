package com.leoyuan.leophoneagent.scheduled

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.leoyuan.leophoneagent.logging.AppLogger
import com.leoyuan.leophoneagent.task.TaskSurfaceStore

/** Boot / timezone / package-replace backup for AlarmManager scheduled tasks. */
object ScheduledTaskReconcile {
    private const val UNIQUE = "leo-scheduled-reconcile"

    fun enqueue(context: Context) {
        runCatching {
            val req = OneTimeWorkRequestBuilder<ScheduledTaskReconcileWorker>()
                .setConstraints(Constraints.NONE)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                UNIQUE,
                ExistingWorkPolicy.REPLACE,
                req,
            )
        }.onFailure {
            // WorkManager missing / process not ready — still reschedule inline.
            AppLogger.warning("ScheduledReconcile", "enqueue failed, inline: ${it.message}")
            runCatching { ScheduledTaskManager(context).rescheduleAll() }
        }
    }
}

class ScheduledTaskReconcileWorker(
    context: Context,
    params: WorkerParameters,
) : Worker(context, params) {
    override fun doWork(): Result {
        return try {
            ScheduledTaskManager(applicationContext).rescheduleAll()
            TaskSurfaceStore.refreshFromStore(applicationContext)
            Result.success()
        } catch (t: Throwable) {
            AppLogger.warning("ScheduledReconcile", "worker failed: ${t.message}")
            Result.retry()
        }
    }
}
