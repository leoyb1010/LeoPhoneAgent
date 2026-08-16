package com.leoyuan.leophoneagent.tile

import android.app.PendingIntent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.leoyuan.leophoneagent.deeplink.SystemEntryIntents
import com.leoyuan.leophoneagent.deeplink.SystemEntryParser

/** Second QS tile: open a new chat and start voice in the foreground App. */
class LeoVoiceTileService : TileService() {
    override fun onStartListening() {
        runCatching {
            qsTile?.apply {
                state = Tile.STATE_INACTIVE
                updateTile()
            }
        }
    }

    override fun onClick() {
        runCatching {
            val intent = SystemEntryIntents.viewIntent(this, SystemEntryParser.VOICE_CHAT_URI)
            val pending = PendingIntent.getActivity(
                this,
                11,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            collapseAndLaunch(pending, intent)
        }
    }
}
