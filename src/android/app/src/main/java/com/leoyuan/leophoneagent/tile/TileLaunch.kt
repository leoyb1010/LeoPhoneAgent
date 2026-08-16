package com.leoyuan.leophoneagent.tile

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.TileService

@SuppressLint("StartActivityAndCollapseDeprecated")
internal fun TileService.collapseAndLaunch(pending: PendingIntent, intent: Intent) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startActivityAndCollapse(pending)
    } else {
        @Suppress("DEPRECATION")
        startActivityAndCollapse(intent)
    }
}
