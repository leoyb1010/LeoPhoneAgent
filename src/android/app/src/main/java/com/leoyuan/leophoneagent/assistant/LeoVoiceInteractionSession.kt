package com.leoyuan.leophoneagent.assistant

import android.app.assist.AssistContent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.service.voice.VoiceInteractionSession
import androidx.annotation.RequiresApi
import com.leoyuan.leophoneagent.MainActivity
import com.leoyuan.leophoneagent.deeplink.DeepLinkCoordinator
import com.leoyuan.leophoneagent.deeplink.SystemEntryParser
import java.io.File
import java.io.FileOutputStream

/**
 * No custom session UI. Capture assist package + optional screenshot,
 * then hand off to MainActivity as a new chat. Any failure degrades to
 * a plain new-chat launch — never crash the process.
 */
class LeoVoiceInteractionSession(context: Context) : VoiceInteractionSession(context) {

    private var sourcePackage: String? = null
    private var screenshotPath: String? = null

    init {
        runCatching { setUiEnabled(false) }
    }

    @RequiresApi(29)
    override fun onHandleAssist(state: AssistState) {
        runCatching {
            super.onHandleAssist(state)
            sourcePackage = state.assistStructure?.activityComponent?.packageName ?: sourcePackage
        }
    }

    @Deprecated("Use onHandleAssist(AssistState) on API 29+")
    override fun onHandleAssist(
        data: Bundle?,
        structure: AssistStructure?,
        content: AssistContent?,
    ) {
        runCatching {
            @Suppress("DEPRECATION")
            super.onHandleAssist(data, structure, content)
            sourcePackage = data?.getString(Intent.EXTRA_ASSIST_PACKAGE)
                ?: structure?.activityComponent?.packageName
                ?: sourcePackage
        }
    }

    override fun onHandleScreenshot(screenshot: Bitmap?) {
        runCatching {
            super.onHandleScreenshot(screenshot)
            screenshotPath = saveScreenshot(context, screenshot)
        }
    }

    override fun onShow(args: Bundle?, showFlags: Int) {
        try {
            runCatching { super.onShow(args, showFlags) }
            val pkg = sourcePackage
                ?: args?.getString(Intent.EXTRA_ASSIST_PACKAGE)
                ?: args?.getString(SystemEntryParser.EXTRA_SOURCE_PACKAGE)
            val shot = screenshotPath
            DeepLinkCoordinator.setPendingAssist(pkg, shot)
            val intent = Intent(context, MainActivity::class.java).apply {
                action = Intent.ACTION_ASSIST
                data = Uri.parse(SystemEntryParser.NEW_CHAT_URI)
                addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_CLEAR_TOP,
                )
                pkg?.let { putExtra(SystemEntryParser.EXTRA_SOURCE_PACKAGE, it) }
                shot?.let { putExtra(SystemEntryParser.EXTRA_SCREENSHOT_PATH, it) }
            }
            runCatching { context.startActivity(intent) }
        } catch (_: Throwable) {
            runCatching {
                val fallback = Intent(context, MainActivity::class.java).apply {
                    action = Intent.ACTION_VIEW
                    data = Uri.parse(SystemEntryParser.NEW_CHAT_URI)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                }
                context.startActivity(fallback)
            }
        } finally {
            runCatching { hide() }
        }
    }

    companion object {
        fun saveScreenshot(context: Context, screenshot: Bitmap?): String? {
            if (screenshot == null || screenshot.isRecycled) return null
            return try {
                val copy = if (screenshot.config == Bitmap.Config.HARDWARE) {
                    screenshot.copy(Bitmap.Config.ARGB_8888, false) ?: return null
                } else {
                    screenshot
                }
                val dir = File(context.cacheDir, "assist").apply { mkdirs() }
                val file = File(dir, "assist-${System.currentTimeMillis()}.png")
                FileOutputStream(file).use { out ->
                    copy.compress(Bitmap.CompressFormat.PNG, 90, out)
                }
                if (copy !== screenshot) runCatching { copy.recycle() }
                file.absolutePath
            } catch (_: Throwable) {
                null
            }
        }
    }
}
