package com.leoyuan.leophoneagent.tile

import android.app.PendingIntent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.leoyuan.leophoneagent.R
import com.leoyuan.leophoneagent.deeplink.SystemEntryIntents
import com.leoyuan.leophoneagent.deeplink.SystemEntryParser

/** On-demand Quick Settings entry for the local Treasury workspace. */
class LeoTreasuryTileService : TileService() {
    override fun onStartListening() {
        runCatching {
            qsTile?.apply {
                state = Tile.STATE_INACTIVE
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    subtitle = getString(R.string.qs_tile_treasury_subtitle)
                }
                updateTile()
            }
        }
    }

    override fun onClick() {
        val intent = SystemEntryIntents.viewIntent(this, SystemEntryParser.TREASURY_URI)
        val pending = PendingIntent.getActivity(
            this,
            12,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        runCatching { collapseAndLaunch(pending, intent) }
    }
}
