package com.leoyuan.leophoneagent.assistant

import android.service.voice.VoiceInteractionService

/**
 * Lightweight always-on voice interactor so OEMs list LeoPhoneAgent as a
 * replaceable digital assistant. Heavy UI lives in the session + MainActivity.
 */
class LeoVoiceInteractionService : VoiceInteractionService()
