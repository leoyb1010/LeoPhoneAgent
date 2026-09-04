import Foundation

/// Content-driven split decision shared by the iPhone/iPad workspace and the
/// lightweight logic-test target. Device names are deliberately irrelevant:
/// Stage Manager, Split View and mirrored windows can all resize continuously.
enum LeoWorkspaceLayoutPolicy {
    static func usesSplit(width: CGFloat, height: CGFloat, regularWidth: Bool) -> Bool {
        guard regularWidth, width.isFinite, height.isFinite, height >= 480 else { return false }
        let sidebar = min(max(width * 0.38, 300), 380)
        let detail = width - sidebar
        return sidebar >= 300 && detail >= 440
    }
}

/// Pure helpers for agent-loop correctness that MinisTests can compile
/// without UIKit or the full chat view-model.
enum AgentChatCorrectness {
    enum TailRole { case user, assistant }
    enum TailPart {
        case text(String)
        case toolUse
        case toolResult
        case other
    }

    /// Persisted message-tail shapes that can safely offer Resume.
    static func isInterruptedTail(role: TailRole, parts: [TailPart]) -> Bool {
        switch role {
        case .user:
            // If the persisted tail is a non-empty user turn, no assistant
            // reply followed it. That includes tool results, the synthetic
            // Continue reminder and an ordinary unanswered user message.
            return !parts.isEmpty
        case .assistant:
            return parts.contains {
                if case .toolUse = $0 { return true }
                return false
            }
        }
    }

    /// Last assistant row, even when a queued user message sits after it.
    static func lastAssistantIndex(isAssistant: [Bool]) -> Int? {
        isAssistant.lastIndex(of: true)
    }

    /// Image attachments must not enter send or enqueue on a text-only model.
    static func shouldBlockImageAttachments(hasImages: Bool, supportsImageInput: Bool) -> Bool {
        hasImages && !supportsImageInput
    }

    /// `read_image` is a vision tool. Register it only when the *active* model
    /// can consume image input — not a leftover default like Haiku.
    static func shouldRegisterReadImage(supportsImageInput: Bool) -> Bool {
        supportsImageInput
    }

    /// Reminder after some attached images were saved to disk but not inlined.
    /// Non-vision models must not be told to call `read_image` or that they saw the files.
    static func omittedImageReminder(inlined: Int, total: Int, supportsImageInput: Bool) -> String? {
        guard total > inlined else { return nil }
        let omitted = total - inlined
        if supportsImageInput {
            return "<system-reminder>Only \(inlined) of \(total) images are inlined above."
                + " The remaining \(omitted) are saved to disk — use read_image to view them."
                + " To stay within the context image limit, process images in batches:"
                + " read a batch, analyze, then summarize your findings before reading the next batch.</system-reminder>"
        }
        return "<system-reminder>Only \(inlined) of \(total) images were kept as on-disk files."
            + " This model cannot view images. Do not claim you inspected, OCR'd, or described"
            + " their pixels. Refer to the saved paths only, or ask the user to switch to a vision model.</system-reminder>"
    }

    /// Drop already-scheduled stream UI writes after Stop, or when the
    /// assistant row was rebuilt under a different identity.
    static func shouldApplyStreamDelta(
        userDidCancel: Bool,
        messageId: UUID?,
        expectedMessageId: UUID?
    ) -> Bool {
        guard !userDidCancel else { return false }
        if let expectedMessageId, let messageId, messageId != expectedMessageId {
            return false
        }
        return true
    }
}

/// Fast native intents. Same contract as Android `ActionRouter`.
enum ActionRouter {
    enum Path { case native, clarify, agent }
    enum Kind {
        case savePhoto, setAlarm, createCalendar, createTravel, toggleFlashlight, createTodo
        case readClipboard, writeClipboard, deviceInfo
    }

    struct Decision {
        var path: Path
        var kind: Kind?
        var hour: Int?
        var minute: Int?
        var tomorrow: Bool
        var dayOffset = 0
        var label: String
        var location = ""
        var notes = ""
        var missingFields: [String] = []

        var effectiveDayOffset: Int { min(366, max(0, dayOffset > 0 ? dayOffset : (tomorrow ? 1 : 0))) }

        var chip: String {
            switch kind {
            case .savePhoto: return "系统相册"
            case .setAlarm: return "系统闹钟"
            case .createCalendar: return "系统日历"
            case .createTravel: return "出行记录"
            case .toggleFlashlight: return "手电筒"
            case .createTodo: return "待办"
            case .readClipboard, .writeClipboard: return "剪贴板"
            case .deviceInfo: return "设备信息"
            case nil: return ""
            }
        }

        func spoken() -> String {
            switch kind {
            case .savePhoto: return "已用系统相册保存，未打开界面。"
            case .setAlarm:
                let hh = String(format: "%02d", hour ?? 0)
                let mm = String(format: "%02d", minute ?? 0)
                return "已用系统闹钟设定 \(hh):\(mm)，未打开界面。"
            case .createCalendar:
                return path == .clarify
                    ? "我已识别为日程，还需要：\(missingFields.joined(separator: "、"))。补充后我会写入系统日历。"
                    : "已用系统日历创建日程，未打开界面。"
            case .createTravel:
                return path == .clarify
                    ? "我已识别为出行记录，还需要：\(missingFields.joined(separator: "、"))。补充后我会同时写入日历和提醒事项。"
                    : "已把出行信息写入系统日历和提醒事项，并设置提前提醒。"
            case .toggleFlashlight: return label == "off" ? "已关掉手电筒。" : "已打开手电筒。"
            case .createTodo:
                return path == .clarify
                    ? "我已识别为提醒，还需要：\(missingFields.joined(separator: "、"))。"
                    : "已记下待办：\(label)。"
            case .readClipboard: return "已读取剪贴板。"
            case .writeClipboard: return "已写入剪贴板。"
            case .deviceInfo: return "已读取这台设备的信息。"
            case nil: return ""
            }
        }

        func receipt(summary: String? = nil) -> String {
            let undo: String
            switch kind {
            case .savePhoto: undo = "可在系统相册中删除"
            case .setAlarm: undo = "可在系统时钟中关闭"
            case .createCalendar, .createTravel: undo = "可在系统日历或提醒事项中删除"
            case .toggleFlashlight: undo = "可用相反指令恢复"
            case .createTodo: undo = "可在系统提醒事项中删除"
            case .writeClipboard: undo = "可再次写入或清空剪贴板"
            case .readClipboard, .deviceInfo: undo = "只读操作，无需撤销"
            case nil: undo = "无需撤销"
            }
            return "\(summary ?? spoken())\n\n执行凭证\n- 路径：\(chip)\n- 核对：系统已确认完成\n- 撤销：\(undo)"
        }

        func failureReceipt(nextStep: String) -> String {
            "没有完成这项操作。\n\n执行凭证\n- 路径：\(chip)\n- 核对：系统未确认完成\n- 下一步：\(nextStep)"
        }
    }

    static func decide(text: String, imageCount: Int) -> Decision {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = raw.lowercased()
        if imageCount > 0 && isSavePhoto(lower) {
            return Decision(path: .native, kind: .savePhoto, hour: nil, minute: nil, tomorrow: false, label: "")
        }
        if isReadClipboard(lower) {
            return Decision(path: .native, kind: .readClipboard, hour: nil, minute: nil, tomorrow: false, label: "")
        }
        if let clipboardText = clipboardWriteText(raw, lower: lower) {
            return Decision(path: .native, kind: .writeClipboard, hour: nil, minute: nil, tomorrow: false, label: clipboardText)
        }
        if isDeviceInfo(lower) {
            return Decision(path: .native, kind: .deviceInfo, hour: nil, minute: nil, tomorrow: false, label: "")
        }
        if let on = flashlightOn(lower) {
            return Decision(path: .native, kind: .toggleFlashlight, hour: nil, minute: nil, tomorrow: false, label: on ? "on" : "off")
        }
        if let travel = parseTravel(raw, lower: lower) { return travel }
        if isTodo(lower) {
            let time = parseTime(raw, lower: lower)
            let title = todoTitle(raw)
            return Decision(
                path: title.isEmpty ? .clarify : .native,
                kind: .createTodo,
                hour: time?.0,
                minute: time?.1,
                tomorrow: isTomorrow(lower),
                dayOffset: dayOffset(lower),
                label: title,
                notes: "原始指令：\(raw)",
                missingFields: title.isEmpty ? ["要提醒的事情"] : []
            )
        }
        if isAlarm(raw, lower: lower), let time = parseTime(raw, lower: lower) {
            return Decision(path: .native, kind: .setAlarm, hour: time.0, minute: time.1, tomorrow: isTomorrow(lower), dayOffset: dayOffset(lower), label: alarmLabel(raw))
        }
        if isCalendar(lower) {
            guard let time = parseTime(raw, lower: lower) else {
                return Decision(path: .clarify, kind: .createCalendar, hour: nil, minute: nil, tomorrow: isTomorrow(lower), dayOffset: dayOffset(lower), label: calendarTitle(raw), notes: "原始指令：\(raw)", missingFields: ["开始时间"])
            }
            return Decision(path: .native, kind: .createCalendar, hour: time.0, minute: time.1, tomorrow: isTomorrow(lower), dayOffset: dayOffset(lower), label: calendarTitle(raw), location: extractLocation(raw), notes: "原始指令：\(raw)")
        }
        return Decision(path: .agent, kind: nil, hour: nil, minute: nil, tomorrow: false, label: "")
    }

    static func parseTravel(_ raw: String, lower: String? = nil) -> Decision? {
        let low = lower ?? raw.lowercased()
        guard let vehicle = ["高铁", "动车", "火车", "航班", "飞机", "客车", "大巴", "轮船", "行程", "train", "flight", "bus", "trip"].first(where: low.contains),
              ["记录", "记下", "记一下", "提醒", "行程", "日历", "别忘", "record", "remind", "schedule"].contains(where: low.contains) else { return nil }

        let time = parseTime(raw, lower: low)
        let destination = firstCapture(in: raw, pattern: #"(?:去|到)\s*([\p{L}]{2,16}?)(?:的)?(?:高铁|动车|火车|航班|飞机|客车|大巴|轮船|行程|[，,。\s])"#) ?? ""
        let train = (firstCapture(in: raw, pattern: #"\b([A-Z]{1,3}\s*\d{1,5})\b"#, options: [.caseInsensitive]) ?? "")
            .replacingOccurrences(of: " ", with: "").uppercased()
        let seat = firstCapture(in: raw, pattern: #"座位(?:是|号|[：:])?\s*([0-9]{1,2}[A-Fa-f]|[0-9]{1,2}车(?:厢)?[0-9]{1,3}[A-Fa-f]?号?)"#) ?? ""
        var missing: [String] = []
        if time == nil { missing.append("开车时间") }
        if destination.isEmpty && train.isEmpty { missing.append("目的地或车次/航班号") }
        if train.isEmpty, raw.range(of: #"(?:车次|航班)(?:是|号|[：:])?\s*(?:[，,。]|$)"#, options: .regularExpression) != nil { missing.append("车次") }
        if seat.isEmpty, raw.range(of: #"座位(?:是|号|[：:])?\s*(?:[，,。]|$)"#, options: .regularExpression) != nil { missing.append("座位") }
        let details = [train.isEmpty ? nil : "车次：\(train)", seat.isEmpty ? nil : "座位：\(seat)"]
            .compactMap { $0 }
            .joined(separator: "\n") + "\n原始指令：\(raw)\n未提供的信息保持为空，不做推断。"
        return Decision(
            path: missing.isEmpty ? .native : .clarify,
            kind: .createTravel,
            hour: time?.0,
            minute: time?.1,
            tomorrow: isTomorrow(low),
            dayOffset: dayOffset(low),
            label: [destination, vehicle, train].filter { !$0.isEmpty }.joined(separator: " "),
            location: destination,
            notes: details,
            missingFields: missing
        )
    }

    private static func firstCapture(
        in text: String,
        pattern: String,
        options: NSRegularExpression.Options = []
    ) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[range]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func isSavePhoto(_ lower: String) -> Bool {
        ["相册", "相簿", "save to album", "save to photos", "save this photo", "save this image",
         "save the photo", "save the image", "存进相册", "保存到相册", "存到相册", "放到相册"]
            .contains { lower.contains($0) }
    }

    static func isAlarm(_ raw: String, lower: String) -> Bool {
        if isCalendar(lower) { return false }
        let hit = lower.contains("闹钟") || lower.range(of: #"\bset alarm\b"#, options: .regularExpression) != nil
            || lower.range(of: #"\balarm (for|at)\b"#, options: .regularExpression) != nil
        return hit && parseTime(raw, lower: lower) != nil
    }

    static func isCalendar(_ lower: String) -> Bool {
        ["加到日历", "写入日历", "添加到日历", "加进日历", "记到日历", "安排日程", "add to calendar", "create calendar event", "创建日程"]
            .contains { lower.contains($0) }
    }

    static func flashlightOn(_ lower: String) -> Bool? {
        let off = ["关掉手电筒", "关闭手电筒", "关手电筒", "关上手电筒",
                   "turn off flashlight", "turn off the flashlight", "turn off torch",
                   "flashlight off", "torch off"]
        let on = ["打开手电筒", "开手电筒", "打开手电", "开手电",
                  "turn on flashlight", "turn on the flashlight", "turn on torch",
                  "flashlight on", "torch on"]
        if off.contains(where: { lower.contains($0) }) { return false }
        if on.contains(where: { lower.contains($0) }) { return true }
        return nil
    }

    static func isTodo(_ lower: String) -> Bool {
        ["记个待办", "记一条待办", "添加待办", "写个待办", "提醒我", "记得提醒", "到时候提醒", "别忘了", "别忘记", "帮我记一下", "帮我记下", "add a todo", "add todo", "remind me to", "remember to"]
            .contains { lower.contains($0) }
    }

    static func isReadClipboard(_ lower: String) -> Bool {
        ["读取剪贴板", "读一下剪贴板", "剪贴板里有什么", "剪贴板有什么",
         "read clipboard", "what's in the clipboard", "what is in the clipboard"]
            .contains { lower.contains($0) }
    }

    static func clipboardWriteText(_ raw: String, lower: String? = nil) -> String? {
        let low = lower ?? raw.lowercased()
        let patterns = [
            #"^把(.{1,4000})复制到剪贴板[。.]?$"#,
            #"^复制到剪贴板[：:]?\s*(.{1,4000})$"#,
        ]
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern),
                  let match = regex.firstMatch(in: raw, range: NSRange(raw.startIndex..., in: raw)),
                  match.numberOfRanges > 1,
                  let range = Range(match.range(at: 1), in: raw) else { continue }
            let value = raw[range].trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { return value }
        }
        guard let regex = try? NSRegularExpression(
            pattern: #"^copy\s+(.{1,4000})\s+to\s+(?:the\s+)?clipboard[.!]?$"#,
            options: [.caseInsensitive]
        ), let match = regex.firstMatch(in: low, range: NSRange(low.startIndex..., in: low)),
           let range = Range(match.range(at: 1), in: raw) else { return nil }
        let value = raw[range].trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    static func isDeviceInfo(_ lower: String) -> Bool {
        ["设备信息", "手机信息", "这台手机是什么型号", "这台设备是什么型号",
         "device info", "phone model", "device model"]
            .contains { lower.contains($0) }
    }

    static func isTomorrow(_ lower: String) -> Bool {
        lower.contains("明早") || lower.contains("明天") || lower.contains("tomorrow") || lower.contains("tmrw")
    }

    static func dayOffset(
        _ lower: String,
        today: Date = Date(),
        calendar: Calendar = .current
    ) -> Int {
        if lower.contains("后天") || lower.contains("day after tomorrow") { return 2 }
        if isTomorrow(lower) { return 1 }
        if let days = firstCapture(in: lower, pattern: #"(\d{1,3})\s*天后"#).flatMap(Int.init) {
            return min(366, max(0, days))
        }

        let start = calendar.startOfDay(for: today)
        if let monthText = firstCapture(in: lower, pattern: #"(\d{1,2})月\d{1,2}[日号]?"#),
           let dayText = firstCapture(in: lower, pattern: #"\d{1,2}月(\d{1,2})[日号]?"#),
           let month = Int(monthText), let day = Int(dayText) {
            var year = calendar.component(.year, from: start)
            var components = DateComponents(year: year, month: month, day: day)
            if let first = calendar.date(from: components) {
                if first < start { year += 1; components.year = year }
                if let target = calendar.date(from: components),
                   let delta = calendar.dateComponents([.day], from: start, to: target).day {
                    return min(366, max(0, delta))
                }
            }
        }

        if let match = lower.range(of: #"(?:下)?(?:周|星期)([一二三四五六日天])"#, options: .regularExpression) {
            let value = String(lower[match])
            let symbol = value.last
            let targetWeekday: Int
            switch symbol {
            case "一": targetWeekday = 2
            case "二": targetWeekday = 3
            case "三": targetWeekday = 4
            case "四": targetWeekday = 5
            case "五": targetWeekday = 6
            case "六": targetWeekday = 7
            default: targetWeekday = 1
            }
            let current = calendar.component(.weekday, from: start)
            let thisWeek = (targetWeekday - current + 7) % 7
            return min(366, thisWeek + (value.hasPrefix("下") ? 7 : 0))
        }
        return 0
    }

    static func parseTime(_ raw: String, lower: String? = nil) -> (Int, Int)? {
        let low = lower ?? raw.lowercased()
        if let m = raw.range(of: #"(\d{1,2})[:：](\d{2})"#, options: .regularExpression) {
            let parts = raw[m].split { $0 == ":" || $0 == "：" }
            guard parts.count == 2, let h0 = Int(parts[0]), let min = Int(parts[1]) else { return nil }
            return valid(adjustHour(h0, lower: low, at: raw.distance(from: raw.startIndex, to: m.lowerBound)), min)
        }
        if let m = raw.range(of: #"(\d{1,2})\s*点\s*(\d{1,2})?\s*分?"#, options: .regularExpression) {
            let chunk = String(raw[m])
            let nums = chunk.components(separatedBy: CharacterSet.decimalDigits.inverted).compactMap(Int.init)
            guard let h0 = nums.first else { return nil }
            let min = nums.count > 1 ? nums[1] : 0
            return valid(adjustHour(h0, lower: low, at: raw.distance(from: raw.startIndex, to: m.lowerBound)), min)
        }
        if let m = low.range(of: #"\b(\d{1,2})\s*([ap])m\b"#, options: .regularExpression) {
            let chunk = String(low[m])
            let num = Int(chunk.filter(\.isNumber)) ?? 0
            var h = num
            if chunk.contains("p") && h < 12 { h += 12 }
            if chunk.contains("a") && h == 12 { h = 0 }
            return valid(h, 0)
        }
        return nil
    }

    private static func adjustHour(_ hour: Int, lower: String, at: Int) -> Int {
        let idx = lower.index(lower.startIndex, offsetBy: min(at, lower.count))
        let prefix = String(lower[..<idx])
        let evening = prefix.contains("晚") || prefix.contains("下午") || prefix.contains("pm")
        let morning = prefix.contains("早") || prefix.contains("上午") || prefix.contains("am")
        if evening && (1...11).contains(hour) { return hour + 12 }
        if morning && hour == 12 { return 0 }
        return hour
    }

    private static func valid(_ hour: Int, _ minute: Int) -> (Int, Int)? {
        (0...23).contains(hour) && (0...59).contains(minute) ? (hour, minute) : nil
    }

    private static func alarmLabel(_ raw: String) -> String {
        let stripped = raw
            .replacingOccurrences(of: #"明早|明天|tomorrow|tmrw|闹钟|set alarm|alarm for|alarm at"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"\d{1,2}[:：]\d{2}"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\d{1,2}\s*点\s*\d{0,2}\s*分?"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: " ，,。.:："))
        return stripped.isEmpty ? "闹钟" : stripped
    }

    private static func calendarTitle(_ raw: String) -> String {
        let stripped = raw
            .replacingOccurrences(of: #"加到日历|写入日历|添加到日历|加进日历|记到日历|安排日程|add to calendar|create calendar event|创建日程"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"今天|今晚|今早|明早|明天|后天|tomorrow|tmrw|day after tomorrow"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"\d{1,3}\s*天后|\d{1,2}月\d{1,2}[日号]?|(?:下)?(?:周|星期)[一二三四五六日天]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"上午|中午|下午|晚上|早上|凌晨"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\d{1,2}[:：]\d{2}"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\d{1,2}\s*点\s*\d{0,2}\s*分?"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: " ，,。.:："))
        return stripped.isEmpty ? "日程" : stripped
    }

    private static func todoTitle(_ raw: String) -> String {
        let stripped = raw
            .replacingOccurrences(
                of: #"记个待办|记一条待办|添加待办|写个待办|提醒我|记得提醒|到时候提醒|别忘了|别忘记|帮我记一下|帮我记下|add a todo|add todo|remind me to|remember to"#,
                with: "",
                options: [.regularExpression, .caseInsensitive]
            )
            .replacingOccurrences(of: #"今天|今晚|今早|明早|明天|后天|tomorrow|tmrw|day after tomorrow"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"\d{1,3}\s*天后|\d{1,2}月\d{1,2}[日号]?|(?:下)?(?:周|星期)[一二三四五六日天]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"上午|中午|下午|晚上|早上|凌晨"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\d{1,2}[:：]\d{2}"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\d{1,2}\s*点\s*\d{0,2}\s*分?"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"^(?:要|的|在|于)\s*"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: " ，,。.:："))
        return stripped
    }

    private static func extractLocation(_ raw: String) -> String {
        firstCapture(in: raw, pattern: #"(?:在|去|到)\s*([\p{L}0-9·_-]{2,24}?)(?:开会|复诊|办事|见面|[，,。\s])"#) ?? ""
    }
}
