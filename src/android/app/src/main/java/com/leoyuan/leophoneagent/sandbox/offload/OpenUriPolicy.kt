package com.leoyuan.leophoneagent.sandbox.offload

/**
 * `android-open` 的 URI 准入策略。纯字符串判定，不碰 Android 框架，
 * 所以能被 JVM 单测直接覆盖（本仓 unit test 没有 Robolectric，
 * `Intent.parseUri` 在测试里只会返回默认值）。
 *
 * why 存在（review P0#3）：`intent:` / `android-app:` URI 可以在
 * `#Intent;…;end` 片段里内联 `component=<pkg>/<cls>`。`Intent.parseUri`
 * 会把它解析成**显式** Intent —— 显式 Intent 绕过 intent-filter 匹配，
 * 可以直接拉起目标包里任意 exported 的 activity。
 *
 * 而进到这条工具通道的字符串未必来自用户：Agent 从网页、文件、别的工具输出里
 * 抓回来的任何文本都可能走到 `android-open`。把"启动哪个组件"的决定权交给
 * 内容源，就是提示注入的落地点。
 *
 * 允许 `package=`：它仍然要过 intent-filter 匹配，只是把候选收窄到某个 App，
 * 这是 `market:` / 深链的正常用法。
 */
internal object OpenUriPolicy {

    /** 这个 URL 是否走 `Intent.parseUri(URI_INTENT_SCHEME)` 路径。 */
    fun isIntentStyleUri(url: String): Boolean {
        val lower = url.trimStart().lowercase()
        return lower.startsWith("intent:") || lower.startsWith("android-app:")
    }

    /**
     * 文本层面预检：URI 的 `#Intent;…;end` 片段里是否声明了显式组件。
     *
     * 之所以在解析之前先做一遍文本检查（解析之后还会再查一次
     * `intent.component` / `intent.selector.component`）：
     *  * 不同 API level 上 `parseUri` 的容错行为并不完全一致；
     *  * 嵌套 selector（`SEL;…;end`）里的 `component=` 在某些版本上不会
     *    体现在顶层 `intent.component` 上；
     *  * 失败要发生在构造 Intent **之前**，不给中间态留窗口。
     *
     * 匹配的是 Intent URI 语法里的 `component=` 键，键必须出现在 `;` 之后
     * （或片段开头），避免把 query 里恰好含 "component=" 的普通 URL 误判。
     */
    fun declaresExplicitComponent(url: String): Boolean {
        if (!isIntentStyleUri(url)) return false
        val fragment = url.substringAfter('#', "")
        if (fragment.isEmpty()) return false
        return fragment.split(';')
            .any { part -> part.trimStart().startsWith(COMPONENT_KEY, ignoreCase = true) }
    }

    private const val COMPONENT_KEY = "component="
}
