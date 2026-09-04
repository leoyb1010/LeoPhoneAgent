package com.leoyuan.leophoneagent.agent

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/**
 * Fast path in front of the agent loop. Only high-precision native
 * intents skip the model; everything else stays on the existing loop.
 *
 * ponytail: keyword + clock parse, not a second LLM. Ceiling is
 * paraphrases the regex misses — those fall through to Reasoning.
 */
object ActionRouter {
    enum class Path { Native, Clarify, Agent }
    enum class Kind {
        SavePhoto, SetAlarm, CreateCalendar, CreateTravel, ToggleFlashlight, CreateTodo,
        ReadClipboard, WriteClipboard, DeviceInfo,
    }

    data class Decision(
        val path: Path,
        val kind: Kind? = null,
        val hour: Int? = null,
        val minute: Int? = null,
        val tomorrow: Boolean = false,
        val dayOffset: Int = if (tomorrow) 1 else 0,
        val label: String = "",
        val location: String = "",
        val notes: String = "",
        val missingFields: List<String> = emptyList(),
    ) {
        val chip: String
            get() = when (kind) {
                Kind.SavePhoto -> "系统相册"
                Kind.SetAlarm -> "系统闹钟"
                Kind.CreateCalendar -> "系统日历"
                Kind.CreateTravel -> "出行记录"
                Kind.ToggleFlashlight -> "手电筒"
                Kind.CreateTodo -> "待办"
                Kind.ReadClipboard, Kind.WriteClipboard -> "剪贴板"
                Kind.DeviceInfo -> "设备信息"
                null -> ""
            }

        val effectiveDayOffset: Int get() = dayOffset.coerceIn(0, 366)

        fun spoken(): String = when (kind) {
            Kind.SavePhoto -> "已用系统相册保存，未打开界面。"
            Kind.SetAlarm -> {
                val hh = hour?.toString()?.padStart(2, '0') ?: "--"
                val mm = minute?.toString()?.padStart(2, '0') ?: "--"
                "已用系统闹钟设定 $hh:$mm，未打开界面。"
            }
            Kind.CreateCalendar -> if (path == Path.Clarify) {
                "我已识别为日程，还需要：${missingFields.joinToString("、")}。补充后我会写入系统日历。"
            } else {
                "已用系统日历创建日程，未打开界面。"
            }
            Kind.CreateTravel -> if (path == Path.Clarify) {
                "我已识别为出行记录，还需要：${missingFields.joinToString("、")}。补充后我会同时写入日历和待办提醒。"
            } else {
                "已把出行信息写入系统日历和本机待办，并设置提前提醒。"
            }
            Kind.ToggleFlashlight -> if (label == "off") "已关掉手电筒。" else "已打开手电筒。"
            Kind.CreateTodo -> if (path == Path.Clarify) {
                "我已识别为提醒，还需要：${missingFields.joinToString("、")}。"
            } else {
                "已记下待办：$label。"
            }
            Kind.ReadClipboard -> "已读取剪贴板。"
            Kind.WriteClipboard -> "已写入剪贴板。"
            Kind.DeviceInfo -> "已读取这台设备的信息。"
            null -> ""
        }

        /** Compact proof for a completed native action; keeps chat useful without a debug panel. */
        fun receipt(summary: String = spoken()): String {
            val undo = when (kind) {
                Kind.SavePhoto -> "可在系统相册中删除"
                Kind.SetAlarm -> "可在系统时钟中关闭"
                Kind.CreateCalendar, Kind.CreateTravel -> "可在系统日历中删除"
                Kind.ToggleFlashlight -> "可用相反指令恢复"
                Kind.CreateTodo -> "可在 LeoPhoneAgent 待办中删除"
                Kind.WriteClipboard -> "可再次写入或清空剪贴板"
                Kind.ReadClipboard, Kind.DeviceInfo -> "只读操作，无需撤销"
                null -> "无需撤销"
            }
            return "$summary\n\n执行凭证\n- 路径：$chip\n- 核对：系统已确认完成\n- 撤销：$undo"
        }

        fun failureReceipt(nextStep: String): String =
            "没有完成这项操作。\n\n执行凭证\n- 路径：$chip\n- 核对：系统未确认完成\n- 下一步：$nextStep"
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
        parseTravel(raw, lower)?.let { return it }
        if (isTodo(lower)) {
            val time = parseTime(raw, lower)
            val title = todoTitle(raw)
            return Decision(
                path = if (title.isBlank()) Path.Clarify else Path.Native,
                kind = Kind.CreateTodo,
                hour = time?.first,
                minute = time?.second,
                tomorrow = isTomorrow(lower),
                dayOffset = dayOffset(lower),
                label = title,
                notes = "原始指令：$raw",
                missingFields = if (title.isBlank()) listOf("要提醒的事情") else emptyList(),
            )
        }
        if (isAlarm(raw, lower)) {
            val time = parseTime(raw, lower) ?: return Decision(Path.Agent)
            return Decision(
                path = Path.Native,
                kind = Kind.SetAlarm,
                hour = time.first,
                minute = time.second,
                tomorrow = isTomorrow(lower),
                dayOffset = dayOffset(lower),
                label = alarmLabel(raw),
            )
        }
        if (isCalendar(lower)) {
            val time = parseTime(raw, lower)
            if (time == null) {
                return Decision(
                    path = Path.Clarify,
                    kind = Kind.CreateCalendar,
                    tomorrow = isTomorrow(lower),
                    dayOffset = dayOffset(lower),
                    label = calendarTitle(raw),
                    notes = "原始指令：$raw",
                    missingFields = listOf("开始时间"),
                )
            }
            return Decision(
                path = Path.Native,
                kind = Kind.CreateCalendar,
                hour = time.first,
                minute = time.second,
                tomorrow = isTomorrow(lower),
                dayOffset = dayOffset(lower),
                label = calendarTitle(raw),
                location = extractLocation(raw),
                notes = "原始指令：$raw",
            )
        }
        return Decision(Path.Agent)
    }

    /** High-precision travel record compiler; incomplete fields never reach an LLM to guess. */
    internal fun parseTravel(raw: String, lower: String = raw.lowercase()): Decision? {
        val vehicle = listOf("高铁", "动车", "火车", "航班", "飞机", "客车", "大巴", "轮船", "行程", "train", "flight", "bus", "trip")
            .firstOrNull { lower.contains(it) } ?: return null
        if (listOf("记录", "记下", "记一下", "提醒", "行程", "日历", "别忘", "record", "remind", "schedule")
                .none { lower.contains(it) }) return null

        val time = parseTime(raw, lower)
        val destination = Regex("""(?:去|到)\s*([\p{L}]{2,16}?)(?:的)?(?:高铁|动车|火车|航班|飞机|客车|大巴|轮船|行程|[，,。\s])""")
            .find(raw)?.groupValues?.getOrNull(1)?.trim().orEmpty()
        val train = Regex("""\b([A-Z]{1,3}\s*\d{1,5})\b""", RegexOption.IGNORE_CASE)
            .find(raw)?.groupValues?.getOrNull(1)?.replace(" ", "")?.uppercase().orEmpty()
        val seat = Regex("""座位(?:是|号|[：:])?\s*([0-9]{1,2}[A-Fa-f]|[0-9]{1,2}车(?:厢)?[0-9]{1,3}[A-Fa-f]?号?)""")
            .find(raw)?.groupValues?.getOrNull(1)?.trim().orEmpty()
        val missing = buildList {
            if (time == null) add("开车时间")
            if (destination.isBlank() && train.isBlank()) add("目的地或车次/航班号")
            if (train.isBlank() && Regex("""(?:车次|航班)(?:是|号|[：:])?\s*(?:[，,。]|$)""").containsMatchIn(raw)) add("车次")
            if (seat.isBlank() && Regex("""座位(?:是|号|[：:])?\s*(?:[，,。]|$)""").containsMatchIn(raw)) add("座位")
        }
        val notes = buildString {
            if (train.isNotBlank()) append("车次：$train")
            if (seat.isNotBlank()) {
                if (isNotEmpty()) append("\n")
                append("座位：$seat")
            }
            append("\n原始指令：$raw\n未提供的信息保持为空，不做推断。")
        }.trim()
        return Decision(
            path = if (missing.isEmpty()) Path.Native else Path.Clarify,
            kind = Kind.CreateTravel,
            hour = time?.first,
            minute = time?.second,
            tomorrow = isTomorrow(lower),
            dayOffset = dayOffset(lower),
            label = listOf(destination, vehicle, train).filter(String::isNotBlank).joinToString(" "),
            location = destination,
            notes = notes,
            missingFields = missing,
        )
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
            "add to calendar", "create calendar event", "创建日程", "记到日历", "安排日程",
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
            "提醒我", "记得提醒", "到时候提醒", "别忘了", "别忘记", "帮我记一下", "帮我记下",
            "add a todo", "add todo", "remind me to", "remember to",
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

    internal fun dayOffset(lower: String, today: LocalDate = LocalDate.now()): Int {
        if (lower.contains("后天") || lower.contains("day after tomorrow")) return 2
        if (isTomorrow(lower)) return 1
        Regex("""(\d{1,3})\s*天后""").find(lower)?.groupValues?.getOrNull(1)
            ?.toIntOrNull()?.coerceIn(0, 366)?.let { return it }

        Regex("""(\d{1,2})月(\d{1,2})[日号]?""").find(lower)?.let { match ->
            val month = match.groupValues[1].toIntOrNull()
            val day = match.groupValues[2].toIntOrNull()
            if (month != null && day != null) {
                var target = runCatching { LocalDate.of(today.year, month, day) }.getOrNull()
                if (target != null && target.isBefore(today)) {
                    target = runCatching { target.withYear(today.year + 1) }.getOrNull()
                }
                if (target != null) return ChronoUnit.DAYS.between(today, target).toInt().coerceIn(0, 366)
            }
        }

        val weekday = Regex("""(?:下)?(?:周|星期)([一二三四五六日天])""").find(lower)
        if (weekday != null) {
            val target = when (weekday.groupValues[1]) {
                "一" -> DayOfWeek.MONDAY
                "二" -> DayOfWeek.TUESDAY
                "三" -> DayOfWeek.WEDNESDAY
                "四" -> DayOfWeek.THURSDAY
                "五" -> DayOfWeek.FRIDAY
                "六" -> DayOfWeek.SATURDAY
                else -> DayOfWeek.SUNDAY
            }
            val thisWeekDelta = Math.floorMod(target.value - today.dayOfWeek.value, 7)
            return (thisWeekDelta + if (weekday.value.startsWith("下")) 7 else 0).coerceAtMost(366)
        }
        return 0
    }

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
        val stripped = raw.replace(Regex("""加到日历|写入日历|添加到日历|加进日历|记到日历|安排日程|add to calendar|create calendar event|创建日程""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""今天|今晚|今早|明早|明天|后天|tomorrow|tmrw|day after tomorrow""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""\d{1,3}\s*天后|\d{1,2}月\d{1,2}[日号]?|(?:下)?(?:周|星期)[一二三四五六日天]"""), "")
            .replace(Regex("""上午|中午|下午|晚上|早上|凌晨"""), "")
            .replace(Regex("""\d{1,2}[:：]\d{2}"""), "")
            .replace(Regex("""\d{1,2}\s*点\s*\d{0,2}\s*分?"""), "")
            .replace(Regex("""^(?:要|的|在|于)\s*"""), "")
            .trim(' ', '，', ',', '。', '.', '：', ':')
        return stripped.ifBlank { "日程" }
    }

    private fun todoTitle(raw: String): String {
        val stripped = raw.replace(
            Regex(
                """记个待办|记一条待办|添加待办|写个待办|提醒我|记得提醒|到时候提醒|别忘了|别忘记|帮我记一下|帮我记下|add a todo|add todo|remind me to|remember to""",
                RegexOption.IGNORE_CASE,
            ),
            "",
        )
            .replace(Regex("""今天|今晚|今早|明早|明天|后天|tomorrow|tmrw|day after tomorrow""", RegexOption.IGNORE_CASE), "")
            .replace(Regex("""\d{1,3}\s*天后|\d{1,2}月\d{1,2}[日号]?|(?:下)?(?:周|星期)[一二三四五六日天]"""), "")
            .replace(Regex("""上午|中午|下午|晚上|早上|凌晨"""), "")
            .replace(Regex("""\d{1,2}[:：]\d{2}"""), "")
            .replace(Regex("""\d{1,2}\s*点\s*\d{0,2}\s*分?"""), "")
            .replace(Regex("""^(?:要|的|在|于)\s*"""), "")
            .trim(' ', '，', ',', '。', '.', '：', ':')
        return stripped
    }

    private fun extractLocation(raw: String): String = Regex("""(?:在|去|到)\s*([\p{L}0-9·_-]{2,24}?)(?:开会|复诊|办事|见面|[，,。\s])""")
        .find(raw)?.groupValues?.getOrNull(1)?.trim().orEmpty()
}
