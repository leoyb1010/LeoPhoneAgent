import Foundation

/// Pure helpers for agent-loop correctness that MinisTests can compile
/// without UIKit or the full chat view-model.
enum AgentChatCorrectness {
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
    enum Path { case native, agent }
    enum Kind { case savePhoto, setAlarm, createCalendar, toggleFlashlight, createTodo }

    struct Decision {
        var path: Path
        var kind: Kind?
        var hour: Int?
        var minute: Int?
        var tomorrow: Bool
        var label: String

        var chip: String {
            switch kind {
            case .savePhoto: return "系统相册"
            case .setAlarm: return "系统闹钟"
            case .createCalendar: return "系统日历"
            case .toggleFlashlight: return "手电筒"
            case .createTodo: return "待办"
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
            case .createCalendar: return "已用系统日历创建日程，未打开界面。"
            case .toggleFlashlight: return label == "off" ? "已关掉手电筒。" : "已打开手电筒。"
            case .createTodo: return "已记下待办：\(label.isEmpty ? "待办" : label)。"
            case nil: return ""
            }
        }
    }

    static func decide(text: String, imageCount: Int) -> Decision {
        let raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = raw.lowercased()
        if imageCount > 0 && isSavePhoto(lower) {
            return Decision(path: .native, kind: .savePhoto, hour: nil, minute: nil, tomorrow: false, label: "")
        }
        if let on = flashlightOn(lower) {
            return Decision(path: .native, kind: .toggleFlashlight, hour: nil, minute: nil, tomorrow: false, label: on ? "on" : "off")
        }
        if isTodo(lower) {
            return Decision(path: .native, kind: .createTodo, hour: nil, minute: nil, tomorrow: false, label: todoTitle(raw))
        }
        if isAlarm(raw, lower: lower), let time = parseTime(raw, lower: lower) {
            return Decision(path: .native, kind: .setAlarm, hour: time.0, minute: time.1, tomorrow: isTomorrow(lower), label: alarmLabel(raw))
        }
        if isCalendar(lower), let time = parseTime(raw, lower: lower) {
            return Decision(path: .native, kind: .createCalendar, hour: time.0, minute: time.1, tomorrow: isTomorrow(lower), label: calendarTitle(raw))
        }
        return Decision(path: .agent, kind: nil, hour: nil, minute: nil, tomorrow: false, label: "")
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
        ["加到日历", "写入日历", "添加到日历", "加进日历", "add to calendar", "create calendar event", "创建日程"]
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
        ["记个待办", "记一条待办", "添加待办", "写个待办", "add a todo", "add todo", "remind me to"]
            .contains { lower.contains($0) }
    }

    static func isTomorrow(_ lower: String) -> Bool {
        lower.contains("明早") || lower.contains("明天") || lower.contains("tomorrow") || lower.contains("tmrw")
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
            .replacingOccurrences(of: #"加到日历|写入日历|添加到日历|加进日历|add to calendar|create calendar event|创建日程"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"明早|明天|tomorrow|tmrw"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"\d{1,2}[:：]\d{2}"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\d{1,2}\s*点\s*\d{0,2}\s*分?"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: " ，,。.:："))
        return stripped.isEmpty ? "日程" : stripped
    }

    private static func todoTitle(_ raw: String) -> String {
        let stripped = raw
            .replacingOccurrences(
                of: #"记个待办|记一条待办|添加待办|写个待办|add a todo|add todo|remind me to"#,
                with: "",
                options: [.regularExpression, .caseInsensitive]
            )
            .trimmingCharacters(in: CharacterSet(charactersIn: " ，,。.:："))
        return stripped.isEmpty ? "待办" : stripped
    }
}
