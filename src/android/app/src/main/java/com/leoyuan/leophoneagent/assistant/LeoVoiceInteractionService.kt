package com.leoyuan.leophoneagent.assistant

import android.service.voice.VoiceInteractionService

/**
 * Lightweight always-on voice interactor so OEMs list LeoPhoneAgent as a
 * replaceable digital assistant. Heavy UI lives in the session + MainActivity.
 * onReady is wrapped: a bind-time OEM quirk must not kill the app process.
 */
class LeoVoiceInteractionService : VoiceInteractionService() {
    override fun onReady() {
        runCatching { super.onReady() }
    }
}
