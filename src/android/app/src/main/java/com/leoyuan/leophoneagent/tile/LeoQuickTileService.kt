package com.leoyuan.leophoneagent.tile

import android.app.PendingIntent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.deeplink.SystemEntryIntents
import com.leoyuan.leophoneagent.deeplink.SystemEntryParser
import com.leoyuan.leophoneagent.task.TaskSurfaceState
import com.leoyuan.leophoneagent.task.TaskSurfaceStore

/** Quick Settings tile: collapse the shade and open a new chat. */
class LeoQuickTileService : TileService() {

    override fun onStartListening() {
        runCatching {
            qsTile?.apply {
                state = Tile.STATE_INACTIVE
                val snap = runCatching { TaskSurfaceStore.current() }.getOrNull()
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    subtitle = when (snap?.state) {
                        TaskSurfaceState.RUNNING -> getString(R.string.task_state_running)
                        TaskSurfaceState.PAUSED -> getString(R.string.task_state_paused)
                        TaskSurfaceState.NEEDS_ATTENTION -> getString(R.string.task_state_needs_attention)
                        TaskSurfaceState.COMPLETED -> getString(R.string.task_state_completed)
                        else -> getString(R.string.qs_tile_subtitle)
                    }
                }
                updateTile()
            }
        }
    }

    override fun onClick() {
        runCatching { launch(SystemEntryParser.NEW_CHAT_URI) }
            .onFailure { runCatching { launch(SystemEntryParser.NEW_CHAT_URI) } }
    }

    private fun launch(uri: String) {
        val intent = SystemEntryIntents.viewIntent(this, uri)
        val pending = PendingIntent.getActivity(
            this,
            10,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        collapseAndLaunch(pending, intent)
    }
}
