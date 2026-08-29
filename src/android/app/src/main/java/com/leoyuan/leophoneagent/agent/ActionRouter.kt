package com.leoyuan.leophoneagent.agent

/**
 * Fast path in front of the agent loop. Only high-precision native
 * intents skip the model; everything else stays on the existing loop.
 *
 * ponytail: keyword + clock parse, not a second LLM. Ceiling is
 * paraphrases the regex misses — those fall through to Reasoning.
 */
object ActionRouter {
    enum class Path { Native, Agent }
    enum class Kind {
        SavePhoto, SetAlarm, CreateCalendar, ToggleFlashlight, CreateTodo,
        ReadClipboard, WriteClipboard, DeviceInfo,
    }

    data class Decision(
        val path: Path,
        val kind: Kind? = null,
        val hour: Int? = null,
        val minute: Int? = null,
        val tomorrow: Boolean = false,
        val label: String = "",
    ) {
        val chip: String
            get() = when (kind) {
                Kind.SavePhoto -> "系统相册"
                Kind.SetAlarm -> "系统闹钟"
                Kind.CreateCalendar -> "系统日历"
                Kind.ToggleFlashlight -> "手电筒"
                Kind.CreateTodo -> "待办"
                Kind.ReadClipboard, Kind.WriteClipboard -> "剪贴板"
                Kind.DeviceInfo -> "设备信息"
                null -> ""
            }

        fun spoken(): String = when (kind) {
            Kind.SavePhoto -> "已用系统相册保存，未打开界面。"
            Kind.SetAlarm -> {
                val hh = hour?.toString()?.padStart(2, '0') ?: "--"
                val mm = minute?.toString()?.padStart(2, '0') ?: "--"
                "已用系统闹钟设定 $hh:$mm，未打开界面。"
            }
            Kind.CreateCalendar -> "已用系统日历创建日程，未打开界面。"
            Kind.ToggleFlashlight -> if (label == "off") "已关掉手电筒。" else "已打开手电筒。"
            Kind.CreateTodo -> "已记下待办：${label.ifBlank { "待办" }}。"
            Kind.ReadClipboard -> "已读取剪贴板。"
            Kind.WriteClipboard -> "已写入剪贴板。"
            Kind.DeviceInfo -> "已读取这台设备的信息。"
            null -> ""
        }
    }

    fun decide(text: String, imageCount: Int): Decision {
        val raw = text.trim()
        val lower = raw.lowercase()
        if (imageCount > 0 && isSavePhoto(lower)) {
            return Decision(Path.Native, Kind.SavePhoto)
        }
        if (isReadClipboard(lower)) {
            return Decision(Path.Native, Kind.ReadClipboard)
        }
        clipboardWriteText(raw, lower)?.let { text ->
            return Decision(Path.Native, Kind.WriteClipboard, label = text)
        }
        if (isDeviceInfo(lower)) {
            return Decision(Path.Native, Kind.DeviceInfo)
        }
        flashlightOn(lower)?.let { on ->
            return Decision(Path.Native, Kind.ToggleFlashlight, label = if (on) "on" else "off")
        }
        if (isTodo(lower)) {
            return Decision(Path.Native, Kind.CreateTodo, label = todoTitle(raw))
        }
        if (isAlarm(raw, lower)) {
            val time = parseTime(raw, lower) ?: return Decision(Path.Agent)
            return Decision(
                path = Path.Native,
                kind = Kind.SetAlarm,
                hour = time.first,
                minute = time.second,
                tomorrow = isTomorrow(lower),
                label = alarmLabel(raw),
            )
        }
        if (isCalendar(lower)) {
            val time = parseTime(raw, lower) ?: return Decision(Path.Agent)
            return Decision(
                path = Path.Native,
                kind = Kind.CreateCalendar,
                hour = time.first,
                minute = time.second,
                tomorrow = isTomorrow(lower),
                label = calendarTitle(raw),
            )
        }
        return Decision(Path.Agent)
    }

    internal fun isSavePhoto(lower: String): Boolean {
        val needles = listOf(
            "相册", "相簿", "save to album", "save to photos",
            "save this photo", "save this image", "save the photo",
            "save the image", "存进相册", "保存到相册", "存到相册", "放到相册",
        )
        return needles.any { lower.contains(it) }
    }

    internal fun isAlarm(raw: String, lower: String): Boolean {
        if (isCalendar(lower)) return false
        val hit = lower.contains("闹钟") || Regex("\\bset alarm\\b").containsMatchIn(lower) ||
            Regex("\\balarm (for|at)\\b").containsMatchIn(lower)
        return hit && parseTime(raw, lower) != null
    }

    internal fun isCalendar(lower: String): Boolean {
        val needles = listOf(
            "加到日历", "写入日历", "添加到日历", "加进日历",
            "add to calendar", "create calendar event", "创建日程",
        )
        return needles.any { lower.contains(it) }
    }

    internal fun flashlightOn(lower: String): Boolean? {
        val off = listOf(
            "关掉手电筒", "关闭手电筒", "关手电筒", "关上手电筒",
            "turn off flashlight", "turn off the flashlight", "turn off torch",
            "flashlight off", "torch off",
        )
        val on = listOf(
            "打开手电筒", "开手电筒", "打开手电", "开手电",
            "turn on flashlight", "turn on the flashlight", "turn on torch",
            "flashlight on", "torch on",
        )
        if (off.any { lower.contains(it) }) return false
        if (on.any { lower.contains(it) }) return true
        return null
    }

    internal fun isTodo(lower: String): Boolean {
        val needles = listOf(
            "记个待办", "记一条待办", "添加待办", "写个待办",
            "add a todo", "add todo", "remind me to",
        )
        return needles.any { lower.contains(it) }
    }

    internal fun isReadClipboard(lower: String): Boolean = listOf(
        "读取剪贴板", "读一下剪贴板", "剪贴板里有什么", "剪贴板有什么",
        "read clipboard", "what's in the clipboard", "what is in the clipboard",
    ).any { lower.contains(it) }

    internal fun clipboardWriteText(raw: String, lower: String = raw.lowercase()): String? {
        Regex("""^把(.{1,4000})复制到剪贴板[。.]?$""").matchEntire(raw)?.let {
            return it.groupValues[1].trim().takeIf(String::isNotEmpty)
        }
        Regex("""^复制到剪贴板[：:]?\s*(.{1,4000})$""").matchEntire(raw)?.let {
            return it.groupValues[1].trim().takeIf(String::isNotEmpty)
        }
        Regex("""^copy\s+(.{1,4000})\s+to\s+(?:the\s+)?clipboard[.!]?$""", RegexOption.IGNORE_CASE)
            .matchEntire(lower)?.let {
                return raw.substring(it.groups[1]!!.range).trim().takeIf(String::isNotEmpty)
            }
        return null
    }

    internal fun isDeviceInfo(lower: String): Boolean = listOf(
        "设备信息", "手机信息", "这台手机是什么型号", "这台设备是什么型号",
        "device info", "phone model", "device model",
    ).any { lower.contains(it) }

    internal fun isTomorrow(lower: String): Boolean =
        lower.contains("明早") || lower.contains("明天") ||
            lower.contains("tomorrow") || lower.contains("tmrw")

    internal fun parseTime(raw: String, lower: String = raw.lowercase()): Pair<Int, Int>? {
        Regex("""(\d{1,2})[:：](\d{2})""").find(raw)?.let { m ->
            val h = adjustHour(m.groupValues[1].toInt(), lower, m.range.first)
            val min = m.groupValues[2].toInt()
            return valid(h, min)
        }
        Regex("""(\d{1,2})\s*点\s*(\d{1,2})?\s*分?""").find(raw)?.let { m ->
            val h = adjustHour(m.groupValues[1].toInt(), lower, m.range.first)
            val min = m.groupValues.getOrNull(2)?.takeIf { it.isNotBlank() }?.toInt() ?: 0
            return valid(h, min)
        }
        Regex("""\b(\d{1,2})\s*([ap])m\b""").find(lower)?.let { m ->
            var h = m.groupValues[1].toInt()
            if (m.groupValues[2] == "p" && h < 12) h += 12
            if (m.groupValues[2] == "a" && h == 12) h = 0
            return valid(h, 0)
        }
        return null
    }

    private fun adjustHour(hour: Int, lower: String, at: Int): Int {
        val prefix = lower.substring(0, at.coerceAtMost(lower.length))
        val morning = prefix.contains("早") || prefix.contains("上午") || prefix.contains("am")
        val evening = prefix.contains("晚") || prefix.contains("下午") || prefix.contains("pm")
        return when {
            evening && hour in 1..11 -> hour + 12
            morning && hour == 12 -> 0
            else -> hour
        }
    }

    private fun valid(hour: Int, minute: Int): Pair<Int, Int>? =
        if (hour in 0..23 && minute in 0..59) hour to minute else null

    private fun alarmLabel(raw: String): String {
        val stripped = raw.replace(Regex("""明早|明天|tomorrow|tmrw|闹钟|set alarm|alarm for|alarm at""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""\d{1,2}[:：]\d{2}"""), "")
            .replace(Regex("""\d{1,2}\s*点\s*\d{0,2}\s*分?"""), "")
            .trim(' ', '，', ',', '。', '.', '：', ':')
        return stripped.ifBlank { "闹钟" }
    }

    private fun calendarTitle(raw: String): String {
        val stripped = raw.replace(Regex("""加到日历|写入日历|添加到日历|加进日历|add to calendar|create calendar event|创建日程""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""明早|明天|tomorrow|tmrw""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""\d{1,2}[:：]\d{2}"""), "")
            .replace(Regex("""\d{1,2}\s*点\s*\d{0,2}\s*分?"""), "")
            .trim(' ', '，', ',', '。', '.', '：', ':')
        return stripped.ifBlank { "日程" }
    }

    private fun todoTitle(raw: String): String {
        val stripped = raw.replace(
            Regex(
                """记个待办|记一条待办|添加待办|写个待办|add a todo|add todo|remind me to""",
                RegexOption.IGNORE_CASE,
            ),
            "",
        ).trim(' ', '，', ',', '。', '.', '：', ':')
        return stripped.ifBlank { "待办" }
    }
}
