package com.leoyuan.leophoneagent.ui.markdown

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.util.LruCache
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.Image

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.leoyuan.leophoneagent.logging.AppLogger
import com.leoyuan.leophoneagent.ui.theme.ChatColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val TAG = "KaTeXView"

/**
 * Renders a LaTeX string using KaTeX in an offscreen WebView, capturing the result as a bitmap.
 * Uses an LRU cache to avoid re-rendering identical expressions.
 */
object KaTeXRendererCache {
    /** [width]/[height] are the bitmap's physical-pixel dimensions
     *  (CSS px * device density) so the image stays sharp on hi-DPI screens.
     *  [cssWidth]/[cssHeight] are KaTeX's reported size in CSS pixels — used
     *  as the dp size for `Image` so the formula displays at the same visual
     *  scale as surrounding text instead of the raw bitmap-pixel size. (T206) */
    data class CacheEntry(
        val bitmap: Bitmap,
        val width: Int,
        val height: Int,
        val cssWidth: Int,
        val cssHeight: Int,
    )

    // [内存] LruCache 的 maxSize 默认按"条数"算，200 条 ARGB_8888 位图完全不设上限：
    // 一条宽公式在 3x 密度下可以是 2000×200×4 ≈ 1.6MB，200 条就是几百 MB。
    // 重写 sizeOf 改成按字节预算（8MB），和同仓 MarkdownParseCaches 的按预算做法一致。
    // 注：sizeOf 返回值的单位由 maxSize 的单位决定，两者都用字节即可自洽。
    private const val CACHE_BUDGET_BYTES = 8 * 1024 * 1024

    // 显式标注超类型：public val 不能暴露匿名对象类型。
    val cache: LruCache<String, CacheEntry> = object : LruCache<String, CacheEntry>(CACHE_BUDGET_BYTES) {
        override fun sizeOf(key: String, value: CacheEntry): Int =
            // allocationByteCount 在 API 19+ 可用（本项目 minSdk 远高于此），
            // 它算的是底层分配，比 byteCount 更接近真实占用。至少记 1 字节，
            // 避免 sizeOf 返回 0 导致 LruCache 抛 "counter inconsistency"。
            value.bitmap.allocationByteCount.coerceAtLeast(1)
    }

    // [主题] cacheKey 必须带 isDark：位图里已经烤死了字色。
    // 原来只按 (latex, displayMode) 做 key —— 深色下渲过一次的白字公式，
    // 切到浅色后会命中同一条缓存，直接在白底上画白字。
    // 聊天那条路径的 KatexWebViewPool.cacheKey 早就带了 isDark，这里补齐。
    fun cacheKey(latex: String, displayMode: Boolean, isDark: Boolean): String =
        (if (displayMode) "D:" else "I:") + (if (isDark) "1:" else "0:") + latex
}

/**
 * Composable that renders a display-mode LaTeX math block.
 */
@Composable
fun MathBlockView(
    latex: String,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        KaTeXRenderView(latex = latex, displayMode = true)
    }
}

/**
 * Core KaTeX rendering composable. Uses a hidden WebView to render LaTeX, then captures
 * the result as a Bitmap displayed via Image composable. Falls back to monospace text on error.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun KaTeXRenderView(
    latex: String,
    displayMode: Boolean,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val density = LocalDensity.current
    // [主题一致性] 跟应用内主题，不跟系统主题。isSystemInDarkTheme() 无视
    // 应用内的浅/深覆盖：系统深色 + 应用内浅色时 KaTeX 会渲白字，
    // 而周围 Compose 背景是浅色 —— 公式白字白底，等于看不见。
    val isDark = ChatColors.isDark
    val fontSize = 16f
    val cacheKey = remember(latex, displayMode, isDark) {
        KaTeXRendererCache.cacheKey(latex, displayMode, isDark)
    }

    // Check cache first
    val cached = remember(cacheKey) { KaTeXRendererCache.cache.get(cacheKey) }

    if (cached != null) {
        // T206: bitmap is rendered at density × CSS px for sharpness, but
        // we display at CSS-pixel dp so the formula visually matches the
        // surrounding 16sp text (otherwise Image maps physical pixels 1:1
        // and the formula renders ~density× too large).
        Image(
            bitmap = cached.bitmap.asImageBitmap(),
            contentDescription = "Math: $latex",
            modifier = modifier.size(cached.cssWidth.dp, cached.cssHeight.dp),
        )
        return
    }

    // State for the rendered bitmap
    var renderedBitmap by remember(cacheKey) { mutableStateOf<Bitmap?>(null) }
    // T206: keep CSS size alongside the bitmap so the post-render Image
    // can size itself the same way the cache-hit path does.
    var renderedCssWidth by remember(cacheKey) { mutableStateOf(0) }
    var renderedCssHeight by remember(cacheKey) { mutableStateOf(0) }
    var renderError by remember(cacheKey) { mutableStateOf<String?>(null) }

    if (renderedBitmap != null) {
        Image(
            bitmap = renderedBitmap!!.asImageBitmap(),
            contentDescription = "Math: $latex",
            modifier = modifier.size(renderedCssWidth.dp, renderedCssHeight.dp),
        )
    } else if (renderError != null) {
        // Fallback: show raw LaTeX in monospace
        Text(
            text = latex,
            style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 14.sp),
            color = MaterialTheme.colorScheme.onSurface,
            modifier = modifier,
        )
    } else {
        // Placeholder while rendering
        Box(
            modifier = modifier
                .then(
                    if (displayMode) Modifier
                        .fillMaxWidth()
                        .height(44.dp)
                    else Modifier
                        .widthIn(min = 20.dp)
                        .height(20.dp)
                ),
        )

        // Render with offscreen WebView
        AndroidView(
            factory = { ctx ->
                WebView(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(1, 1)
                    settings.javaScriptEnabled = true
                    settings.allowFileAccess = true
                    // T208 Layer A: keep WebView text-zoom at 100% regardless
                    // of the user's accessibility font-size setting. Without
                    // this, the bitmap KaTeX renders is multiplied by the
                    // system font scale, but our bridge reports the
                    // pre-scale CSS dimensions — Image then displays the
                    // (over-rendered) bitmap inside an undersized box and
                    // ContentScale.Fit makes the formula appear physically
                    // larger than the surrounding 16sp text.
                    settings.textZoom = 100
                    setBackgroundColor(android.graphics.Color.TRANSPARENT)

                    addJavascriptInterface(object {
                        @JavascriptInterface
                        fun onRendered(width: Int, height: Int, error: String) {
                            if (error.isNotEmpty()) {
                                AppLogger.warning(TAG, "KaTeX render failed: $error · latex=${latex.take(80)}")
                                renderError = error
                                return
                            }
                            if (width <= 0 || height <= 0) {
                                AppLogger.warning(TAG, "KaTeX render produced zero dimensions · latex=${latex.take(80)}")
                                renderError = "zero dimensions"
                                return
                            }
                            // Scale for device density
                            val scale = ctx.resources.displayMetrics.density
                            val bitmapW = (width * scale).toInt()
                            val bitmapH = (height * scale).toInt()

                            // Resize WebView to content size, then capture
                            post {
                                layoutParams = ViewGroup.LayoutParams(bitmapW, bitmapH)
                                requestLayout()
                                postDelayed({
                                    val bitmap = Bitmap.createBitmap(bitmapW, bitmapH, Bitmap.Config.ARGB_8888)
                                    val canvas = android.graphics.Canvas(bitmap)
                                    draw(canvas)
                                    KaTeXRendererCache.cache.put(
                                        cacheKey,
                                        KaTeXRendererCache.CacheEntry(
                                            bitmap = bitmap,
                                            width = bitmapW,
                                            height = bitmapH,
                                            cssWidth = width,
                                            cssHeight = height,
                                        )
                                    )
                                    renderedCssWidth = width
                                    renderedCssHeight = height
                                    renderedBitmap = bitmap
                                }, 100)
                            }
                        }
                    }, "AndroidBridge")

                    webViewClient = object : WebViewClient() {
                        override fun onPageFinished(view: WebView?, url: String?) {
                            super.onPageFinished(view, url)
                            val escapedLatex = latex
                                .replace("\\", "\\\\")
                                .replace("'", "\\'")
                                .replace("\n", "\\n")
                                .replace("\r", "")
                            evaluateJavascript(
                                "renderMath('$escapedLatex', $displayMode, $fontSize, $isDark)",
                                null
                            )
                        }
                    }

                    loadUrl("file:///android_asset/katex/katex-render.html")
                }
            },
            modifier = Modifier.height(0.dp), // Hidden
        )
    }
}
