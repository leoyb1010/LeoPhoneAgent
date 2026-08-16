package com.leoyuan.leophoneagent.assistant

import android.app.assist.AssistContent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import com.leoyuan.leophoneagent.MainActivity
import com.leoyuan.leophoneagent.deeplink.DeepLinkCoordinator
import java.io.File
import java.io.FileOutputStream

/**
 * ponytail: no custom session UI. Capture assist package + screenshot,
 * then hand off to MainActivity as a new chat.
 */
class LeoVoiceInteractionSession(context: Context) : VoiceInteractionSession(context) {

    private var sourcePackage: String? = null
    private var screenshotPath: String? = null

    override fun onHandleAssist(state: AssistState) {
        super.onHandleAssist(state)
        sourcePackage = state.assistStructure?.activityComponent?.packageName ?: sourcePackage
    }

    @Deprecated("Use onHandleAssist(AssistState) on API 29+")
    override fun onHandleAssist(
        data: Bundle?,
        structure: AssistStructure?,
        content: AssistContent?,
    ) {
        @Suppress("DEPRECATION")
        super.onHandleAssist(data, structure, content)
        sourcePackage = data?.getString(Intent.EXTRA_ASSIST_PACKAGE)
            ?: structure?.activityComponent?.packageName
            ?: sourcePackage
    }

    override fun onHandleScreenshot(screenshot: Bitmap?) {
        super.onHandleScreenshot(screenshot)
        screenshotPath = saveScreenshot(context, screenshot)
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        val launch = AssistIntents.Launch(sourcePackage, screenshotPath)
        DeepLinkCoordinator.setPendingAssist(launch)
        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_ASSIST
            data = Uri.parse(AssistIntents.NEW_CHAT_URI)
            addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or
                    Intent.FLAG_ACTIVITY_SINGLE_TOP or
                    Intent.FLAG_ACTIVITY_CLEAR_TOP,
            )
            sourcePackage?.let { putExtra(AssistIntents.EXTRA_SOURCE_PACKAGE, it) }
            screenshotPath?.let { putExtra(AssistIntents.EXTRA_SCREENSHOT_PATH, it) }
        }
        context.startActivity(intent)
        hide()
    }

    companion object {
        fun saveScreenshot(context: Context, screenshot: Bitmap?): String? {
            if (screenshot == null || screenshot.isRecycled) return null
            val dir = File(context.cacheDir, "assist").apply { mkdirs() }
            val file = File(dir, "assist-${System.currentTimeMillis()}.png")
            return try {
                FileOutputStream(file).use { out ->
                    screenshot.compress(Bitmap.CompressFormat.PNG, 90, out)
                }
                file.absolutePath
            } catch (_: Throwable) {
                null
            }
        }
    }
}
