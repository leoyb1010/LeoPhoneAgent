package com.leoyuan.leophoneagent.data.db

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import com.leoyuan.leophoneagent.logging.AppLogger

/** Prevents Room from crashing or destructively opening a DB written by a newer build. */
object DatabaseVersionGuard {
    const val CODE_DB_VERSION = 12
    private const val DB_NAME = "minis.db"

    enum class Decision { PROCEED, SHOW_NEWER_DB_GUIDANCE }

    internal fun decision(onDiskVersion: Int?): Decision =
        if (onDiskVersion != null && onDiskVersion > CODE_DB_VERSION) {
            Decision.SHOW_NEWER_DB_GUIDANCE
        } else {
            Decision.PROCEED
        }

    fun readOnDiskVersion(context: Context): Int? {
        val file = context.getDatabasePath(DB_NAME)
        if (!file.exists()) return null
        return runCatching {
            SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY).use { it.version }
        }.onFailure {
            AppLogger.warning("DbVersionGuard", "read-only version probe failed: ${it.javaClass.simpleName}")
        }.getOrNull()
    }

    fun evaluate(context: Context): Decision = decision(readOnDiskVersion(context))
}
