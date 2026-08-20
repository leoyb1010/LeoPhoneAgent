package com.leoyuan.leophoneagent.sandbox.offload

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import com.leoyuan.leophoneagent.sandbox.NativeOffloadHandler
import com.leoyuan.leophoneagent.sandbox.NativeOffloadRequest
import com.leoyuan.leophoneagent.sandbox.NativeOffloadResult
import org.json.JSONObject

/**
 * Host-side implementation of `android-open <url>` — launches any URL or
 * URI the Android system knows how to resolve (https, tel, mailto, geo,
 * market, intent, etc.).
 *
 * Includes a few OEM-aware fallbacks:
 *   • `market:` URIs on Huawei / no-GMS devices → redirect to AppGallery.
 *   • Any `ActivityNotFoundException` → structured error naming the
 *     missing handler instead of crashing.
 *
 * Usage:
 *   android-open <url>
 *   android-open --help
 */
class OpenOffloadHandler(private val context: Context) : NativeOffloadHandler {
    override fun handle(request: NativeOffloadRequest): NativeOffloadResult {
        val args = OffloadArgs(request.argv.drop(1))
        if (args.hasFlag("h", "help")) return NativeOffloadResult(0, HELP)

        // review P0#3：这里过去**没有**任何 OffloadGate.enforce —— 同一批
        // handler 里 contacts / location / photos … 都有，只有 open 漏了，
        // 而且 `open` 也没注册进 OffloadPermissionManager.toolRegistry，
        // 所以设置页里既看不见也关不掉。补上注册 + 这道门之后，用户至少
        // 有一个能把"让 Agent 拉起别的 App"整体关掉的开关。
        OffloadGate.enforce("open", "android-open", args, request)?.let { return it }

        val url = args.positional.firstOrNull()
        if (url.isNullOrBlank()) {
            return NativeOffloadResult(2, "android-open: missing <url>\n$HELP")
        }

        return tryOpen(url, args)
    }

    private fun tryOpen(url: String, args: OffloadArgs): NativeOffloadResult {
        return try {
            // T259: intent: / android-app: URIs encode action + categories +
            // extras + flags inline (e.g. ACTION_SET_ALARM with HOUR/MINUTES
            // extras). Wrapping them in ACTION_VIEW threw all of that away,
            // so resolveActivity returned null and the call fell through to
            // the no_handler error branch. Use Intent.parseUri to honor the
            // full URI semantics; ACTION_VIEW path stays for plain http/tel
            // /mailto/geo/market URLs.
            val intent: Intent = if (OpenUriPolicy.isIntentStyleUri(url)) {
                // 文本层面先拒一次（见 OpenUriPolicy 的注释）：失败要发生在
                // 构造 Intent 之前，且不依赖某个 API level 上 parseUri 的具体行为。
                if (OpenUriPolicy.declaresExplicitComponent(url)) {
                    return refuseExplicitComponent(url, null, args)
                }
                val parsed = Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
                // review P0#3（注入面）：`intent:` URI 可以内联编码
                // `component=pkg/cls`，`Intent.parseUri` 会把它解析成一个**显式**
                // Intent。显式 Intent 绕过 intent-filter 匹配，可以直接拉起目标
                // 包里任意 exported 的 activity —— 而这条通道上的字符串未必来自
                // 用户：Agent 从网页 / 文件 / 工具输出里抓回来的任何文本都可能
                // 走到这里。把"能启动哪个组件"的决定权交给内容源，就是典型的
                // 提示注入落地点。
                //
                // 因此：带显式 component（或 selector 里带 component）的一律拒绝，
                // 只保留 `package=` 这一级约束 —— 它仍要经过 intent-filter 匹配，
                // 只是把候选范围收窄到某个 App，这正是 `market:`/深链的正常用法。
                val selectorComponent = parsed.selector?.component
                if (parsed.component != null || selectorComponent != null) {
                    return refuseExplicitComponent(
                        url,
                        (parsed.component ?: selectorComponent)?.flattenToShortString(),
                        args,
                    )
                }
                parsed.apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    // Browsers inject a selector to bind the URI to a
                    // specific package; the selector is already known to carry
                    // no component (checked above), and dropping it lets the
                    // system-wide chooser apply.
                    selector = null
                }
            } else {
                Intent(Intent.ACTION_VIEW, Uri.parse(url))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val resolved = intent.resolveActivity(context.packageManager)
            Log.d(TAG, "startActivity url='$url' action=${intent.action} resolved=${resolved?.flattenToShortString()}")
            context.startActivity(intent)
            NativeOffloadResult(0, OffloadOutput.formatBody("Opened: $url", args) + "\n")
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "no handler for '$url'")
            maybeFallback(url, e, args)
        } catch (e: SecurityException) {
            val body = JSONObject().put("error", "open_denied")
                .put("message", "The system refused to open this URL: ${e.message}")
                .put("url", url)
                .toString()
            NativeOffloadResult(1, OffloadOutput.formatBody(body, args) + "\n")
        } catch (e: java.net.URISyntaxException) {
            // T259: parseUri rejected a malformed intent: URI before any
            // resolveActivity call — surface as bad input, not no_handler,
            // so the model knows to fix the URI shape.
            Log.w(TAG, "parseUri failed for '$url': ${e.message}")
            val body = JSONObject().put("error", "bad_intent_uri")
                .put("message", "Malformed intent: URI: ${e.message}")
                .put("url", url)
                .toString()
            NativeOffloadResult(2, OffloadOutput.formatBody(body, args) + "\n")
        } catch (e: Throwable) {
            Log.w(TAG, "uncaught: ${e.message}", e)
            val body = JSONObject().put("error", "open_failed")
                .put("message", e.message ?: "Failed to open URL.")
                .put("url", url)
                .toString()
            NativeOffloadResult(1, OffloadOutput.formatBody(body, args) + "\n")
        }
    }

    /** review P0#3：显式组件一律拒绝，理由见 [OpenUriPolicy]。 */
    private fun refuseExplicitComponent(
        url: String,
        component: String?,
        args: OffloadArgs,
    ): NativeOffloadResult {
        Log.w(TAG, "refusing explicit-component intent URI: ${component ?: url}")
        val body = JSONObject().put("error", "explicit_component_refused")
            .put(
                "message",
                "Refusing an intent: URI that names an explicit component" +
                    (component?.let { " ($it)" } ?: "") +
                    ". Explicit components bypass intent-filter matching and can launch " +
                    "arbitrary exported activities. Use `package=` (or a plain scheme URL) instead.",
            )
            .put("url", url)
            .toString()
        return NativeOffloadResult(2, OffloadOutput.formatBody(body, args) + "\n")
    }

    /**
     * Fallback rules for URLs that couldn't be resolved. Returns a friendly
     * error message with a hint the model can relay to the user.
     */
    private fun maybeFallback(url: String, original: ActivityNotFoundException, args: OffloadArgs): NativeOffloadResult {
        // market: → Huawei AppGallery on HMS-only devices
        if (url.startsWith("market://") && OsCompat.isHuawei) {
            val pkg = Uri.parse(url).getQueryParameter("id")
                ?: url.substringAfter("details?id=").substringBefore('&')
            if (pkg.isNotBlank()) {
                val ag = "https://appgallery.huawei.com/app/$pkg"
                Log.d(TAG, "market: redirect → AppGallery $ag")
                return tryOpen(ag, args)
            }
        }

        val schemeHint = when {
            url.startsWith("mailto:") -> "no email app installed"
            url.startsWith("tel:") -> "no phone/dialer app installed"
            url.startsWith("sms:") -> "no SMS app installed"
            url.startsWith("geo:") -> "no maps app installed"
            url.startsWith("market:") -> "no app store installed"
            url.startsWith("http:") || url.startsWith("https:") -> "no browser installed"
            else -> "no app can handle this URI scheme"
        }
        val body = JSONObject().put("error", "no_handler")
            .put("message", "Cannot open '$url': $schemeHint. Ask the user to install a compatible app.")
            .put("url", url)
            .put("detail", original.message ?: "ActivityNotFoundException")
            .toString()
        return NativeOffloadResult(1, OffloadOutput.formatBody(body, args) + "\n")
    }

    companion object {
        private const val TAG = "OpenOffload"
        private const val HELP = """android-open — open a URL or URI with the system handler

Usage:
  android-open <url>
  android-open --help

Supports https://, tel:, mailto:, geo:, market:, intent:, and any other
scheme a device app can handle. On Huawei devices without Play Store,
market:// URLs automatically fall back to AppGallery.

intent:/android-app: URIs that name an explicit `component=pkg/cls` are
refused — explicit components bypass intent-filter matching and could
launch any exported activity. Use `package=` to scope to an app instead.
Errors are returned as JSON: {"error":"no_handler","message":"...","url":"..."}.
"""
    }
}
