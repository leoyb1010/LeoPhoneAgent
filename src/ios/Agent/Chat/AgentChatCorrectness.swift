import Foundation

/// Content-driven split decision shared by the iPhone/iPad workspace and the
/// lightweight logic-test target. Device names are deliberately irrelevant:
/// Stage Manager, Split View and mirrored windows can all resize continuously.
///
/// [duo-shell] iPhone Duo widths these rules have to land on deterministically
/// (Xcode 27.1 device profile; both displays report the iPhone idiom, so
/// nothing here may key off the device type):
///   outer portrait 466 (compact/regular) · outer landscape 678 (compact/compact)
///   inner portrait 669 · inner landscape 951 (regular/regular) · inner split half ≈ 475
/// Every threshold keeps ≥ 50 pt between itself and the nearest Duo width, so
/// a ±20 pt change in system margins or safe areas cannot flip a layout.
enum LeoWorkspaceLayoutPolicy {
    /// Split shell = sidebar + detail. The sidebar takes 38 % of the window,
    /// clamped to 300…380, so for any window under 790 pt it is exactly 300 and
    /// the split starts at 300 + 440 = 740 pt. Duo inner portrait (669) sits
    /// 71 pt below that and stays a single column; inner landscape (951) splits.
    static let splitSidebarMinWidth: CGFloat = 300
    /// Narrowest detail column the chat is laid out for (composer + model pill).
    static let splitDetailMinWidth: CGFloat = 440
    /// The window width at which `usesSplit` turns on (derived, see above).
    static var splitMinWidth: CGFloat { splitSidebarMinWidth + splitDetailMinWidth }

    /// `regularHeight` is the vertical size class, not a measured height: the
    /// on-screen keyboard shrinks the measured height (an 11" iPad in landscape
    /// fell under the old 480 pt floor), and flipping to one column tore down the
    /// composer being typed in. Landscape phones are compact-height either way.
    static func usesSplit(width: CGFloat, regularWidth: Bool, regularHeight: Bool) -> Bool {
        guard regularWidth, regularHeight, width.isFinite else { return false }
        let sidebar = min(max(width * 0.38, splitSidebarMinWidth), 380)
        let detail = width - sidebar
        return sidebar >= splitSidebarMinWidth && detail >= splitDetailMinWidth
    }

    /// [duo-shell] P2-3 outer-display quick mode: a compact-width window no
    /// wider than 500 pt (Duo outer portrait 466, the inner split half ≈ 475,
    /// any phone in portrait) keeps approvals and running Mac tasks next to
    /// the composer at the bottom, within thumb reach. Outer landscape (678)
    /// and inner portrait (669, regular width) keep the normal home.
    static let quickHomeMaxWidth: CGFloat = 500
    /// 只给「矮胖」的窗口:Duo 外屏竖握 466 × 678(宽高比 0.69)、内屏分屏一半约 475 × 669。
    /// 普通 iPhone 竖屏(如 18 Pro Max 440 × 956,0.46;SE 375 × 667,0.56)不触发,
    /// 免得用户的主力机首页布局被悄悄改掉。
    static let quickHomeMinAspect: CGFloat = 0.62

    static func usesQuickHome(width: CGFloat, height: CGFloat, regularWidth: Bool) -> Bool {
        guard !regularWidth, width.isFinite, height.isFinite, width > 0, height > 0 else { return false }
        return width <= quickHomeMaxWidth && width / height >= quickHomeMinAspect
    }

    // MARK: [WP-43] iPad three columns (session list / chat / context)
    //
    // Numbers from OpenClaw RootTabsNavigation (sidebar 300, detail ≥ 500); the
    // context-column threshold is ours. Rules apply when the window CROSSES a
    // threshold, so a column the user opened or closed by hand stays that way
    // until the window size changes enough to matter.

    static let sidebarWidth = (min: CGFloat(280), ideal: CGFloat(300), max: CGFloat(320))
    /// Chat content column cap (the list's scroll indicator stays at the edge).
    static let contentMaxWidth: CGFloat = 760
    /// Sidebar stays put at or above this; narrower windows get it as a drawer.
    /// [duo-shell] Kept at 800: 740–800 (iPad Stage Manager narrow windows) is a
    /// drawer so the chat keeps ≥ 440 pt; Duo inner landscape (951) is 151 pt
    /// above it, so the sidebar is resident there and the chat gets 651 pt.
    static let residentSidebarMinWidth: CGFloat = 800
    /// The context column (文件/工具详情 · Mac 画面) opens by itself at or above
    /// this: sidebar ideal 300 + inspector ideal 360 + chat min 440 = 1100.
    static let contextColumnMinWidth: CGFloat = 1100
    /// [duo-shell] Below the auto-open width the user can still pin the column
    /// open from this width up: three 300 pt columns (sidebar, chat, inspector
    /// min) fit. Duo inner landscape (951) never reaches 1100, so without the
    /// pin the column would have to be reopened by hand after every fold.
    static let contextColumnPinMinWidth: CGFloat = 900

    static func sidebarResident(width: CGFloat) -> Bool {
        width.isFinite && width >= residentSidebarMinWidth
    }

    /// Auto-open rule (nobody pinned the column).
    static func showsContextColumn(width: CGFloat) -> Bool {
        width.isFinite && width >= contextColumnMinWidth
    }

    static func canPinContextColumn(width: CGFloat) -> Bool {
        width.isFinite && width >= contextColumnPinMinWidth
    }

    /// The rule the inspector follows: auto-open at ≥ 1100, or the user's pin at ≥ 900.
    static func opensContextColumn(width: CGFloat, pinned: Bool) -> Bool {
        showsContextColumn(width: width) || (pinned && canPinContextColumn(width: width))
    }

    /// [leo] 右栏浮在对话上方时(竖握分栏),它盖住的对话尾部宽度,对话把这段让成安全区。
    /// 只认「贴在对话右侧、上下基本等高的一条栏」:系统把右栏临场改成弹出面板时它的 minX 几乎是 0,
    /// 旧算法会把整个对话宽度都让出去 → 对话塌成一条 → 布局翻转 → 右栏关 → 再开,无限闪。
    static func coveredTrailing(content: CGRect, inspector: CGRect) -> CGFloat {
        guard content.width > 0, inspector.width > 0, inspector.height > 0 else { return 0 }
        guard inspector.minX > content.minX + 1, inspector.maxX >= content.maxX - 1 else { return 0 }
        guard inspector.height >= content.height * 0.8 else { return 0 }
        let covered = content.maxX - inspector.minX
        // 让出去后对话至少还剩 300 pt(Duo 内屏 651 的对话 + 360 的右栏也算正常浮动栏)。
        guard covered > 0, covered <= content.width - minimumChatWidth else { return 0 }
        return covered
    }

    /// 手动开 / 关右栏后这段时间里,宽度阈值规则不推翻用户的选择。
    static let handToggleGrace: TimeInterval = 1.5

    /// 右栏浮在对话上时,对话至少保留的宽度。
    static let minimumChatWidth: CGFloat = 300

    /// The new value a threshold rule wants after a resize, or nil when the
    /// resize did not cross the threshold (leave the user's choice alone).
    static func crossing(from old: CGFloat, to new: CGFloat, rule: (CGFloat) -> Bool) -> Bool? {
        guard old > 0 else { return rule(new) }   // first measurement
        let before = rule(old), after = rule(new)
        return before == after ? nil : after
    }
}

/// [duo-shell] Settings sheet: two columns (sidebar + page) or one stack. The
/// sheet measures its own width, which is the window width when it fills the
/// screen (Duo inner display / iPhone) and the page-sheet width on iPad.
enum LeoSettingsLayoutPolicy {
    /// Matches the sidebar's `navigationSplitViewColumnWidth(min:ideal:max:)`.
    static let sidebarWidth = (min: CGFloat(280), ideal: CGFloat(320), max: CGFloat(380))
    /// Narrowest settings page column (settings pages are forms, not the chat).
    static let detailMinWidth: CGFloat = 420
    /// 280 + 420 = 700. Settings is a `.sheet`, so on iPad it is a page sheet
    /// about 704 pt wide and must stay two columns; it must not rise above 704.
    /// Duo inner portrait (669) is 31 pt below, so a ±20 pt margin change still
    /// leaves it a single column (the GeometryReader measures the real width);
    /// Duo inner landscape (951) is two columns.
    static var twoColumnMinWidth: CGFloat { sidebarWidth.min + detailMinWidth }

    static func usesTwoColumns(width: CGFloat) -> Bool {
        width.isFinite && width >= twoColumnMinWidth
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
    /// 系统提示里的本地时间：精确到分钟 + 英文星期（如 "2026-10-20 14:05 Tuesday"）。
    /// [P1-cache] 系统提示只放日期（一天变一次）。精确到分钟的时间放进每条用户消息自己的
    /// `sentAtReminder`：分钟钟表留在 system 尾段时，跨一分钟整段对话历史的缓存就全部失效。
    static func promptDate(_ now: Date, timeZone: TimeZone) -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd EEEE"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = timeZone
        return fmt.string(from: now)
    }

    /// 发送时刻，随用户消息落盘：历史里的字节从此固定，下一轮照样命中缓存。
    /// `<system-reminder>` 块在气泡、复制、编辑里都会被 `stripSystemReminders` 去掉。
    static func sentAtReminder(_ now: Date, timeZone: TimeZone) -> String {
        "<system-reminder>Sent at \(promptClock(now, timeZone: timeZone)) (\(timeZone.identifier)).</system-reminder>"
    }

    /// 给标题模型的正文：去掉 `<system-reminder>` / `<treasury_context>` 块（含「Sent at …」），
    /// 丢掉剥完为空的段，再截断。否则重新生成标题时模型看到的是发送时刻和时区。
    static func titleSourceText(_ textParts: [String], limit: Int) -> String {
        let cleaned = textParts.compactMap { part -> String? in
            let stripped = stripInjectedBlocks(part).trimmingCharacters(in: .whitespacesAndNewlines)
            return stripped.isEmpty ? nil : stripped
        }
        return String(cleaned.joined(separator: "\n").prefix(limit))
    }

    static func stripInjectedBlocks(_ text: String) -> String {
        guard text.contains("<system-reminder>") || text.contains("<treasury_context") else { return text }
        let ns = text as NSString
        return injectedBlockRegex?.stringByReplacingMatches(
            in: text, range: NSRange(location: 0, length: ns.length), withTemplate: "") ?? text
    }

    private static let injectedBlockRegex = try? NSRegularExpression(
        pattern: "<system-reminder>[\\s\\S]*?</system-reminder>|<treasury_context\\b[^>]*>[\\s\\S]*?</treasury_context>"
    )

    static func promptClock(_ now: Date, timeZone: TimeZone) -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "yyyy-MM-dd HH:mm EEEE"
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = timeZone
        return fmt.string(from: now)
    }

    /// [OpenMinis Android 1.15] DeepSeek 等模型偶尔把工具调用写进思考内容里：这一轮没有正文、没有真正的
    /// 工具调用，只有一段「看起来像工具调用」的思考，任务就此停住。认出来就提醒一次再试。
    /// 只认明确的调用标记（各家的工具调用标签，或带 arguments/parameters 的已知工具名 JSON），
    /// 普通的「我需要调用 shell_execute」这种思考不算。
    static func reasoningContainsMisplacedToolCall(text: String, toolCallCount: Int,
                                                   reasoning: String, toolNames: [String]) -> Bool {
        guard toolCallCount == 0,
              text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !reasoning.isEmpty else { return false }
        let lower = reasoning.lowercased()
        let markers = ["<tool_call", "</tool_call>", "<function_call", "<function_calls", "<invoke ", "<invoke>",
                       "tool▁call", "tool_calls_begin", "<|tool_call", "｜dsml｜", "<tool_use"]
        if markers.contains(where: lower.contains) { return true }
        for name in toolNames where !name.isEmpty {
            let pattern = "\"name\"\\s*:\\s*\"" + NSRegularExpression.escapedPattern(for: name.lowercased())
                + "\"[\\s\\S]{0,40}\"(arguments|parameters|input)\"\\s*:"
            if lower.range(of: pattern, options: .regularExpression) != nil {
                return true
            }
        }
        return false
    }

    static func lastAssistantIndex(isAssistant: [Bool]) -> Int? {
        isAssistant.lastIndex(of: true)
    }

    /// Image attachments must not enter send or enqueue on a text-only model — unless a
    /// Vision Group is configured: then the image is saved, the serializer hands the model
    /// its path, and `read_image` reads it through the group. [T-ios-vision-group #182]
    static func shouldBlockImageAttachments(hasImages: Bool, supportsImageInput: Bool,
                                            visionGroupConfigured: Bool = false) -> Bool {
        hasImages && !supportsImageInput && !visionGroupConfigured
    }

    /// `read_image` is registered when the *active* model can consume image input itself
    /// (not a leftover default like Haiku), or when a Vision Group reads on its behalf.
    static func shouldRegisterReadImage(supportsImageInput: Bool, visionGroupConfigured: Bool = false) -> Bool {
        supportsImageInput || visionGroupConfigured
    }

    /// Reminder after some attached images were saved to disk but not inlined.
    /// Non-vision models are told to use `read_image` only when a Vision Group backs it,
    /// and never that they saw the files.
    static func omittedImageReminder(inlined: Int, total: Int, supportsImageInput: Bool,
                                     visionGroupConfigured: Bool = false) -> String? {
        guard total > inlined else { return nil }
        let omitted = total - inlined
        if !supportsImageInput, visionGroupConfigured {
            return "<system-reminder>\(omitted) of \(total) images are saved to disk and not shown to you."
                + " This model cannot view images; call read_image on a saved path (optionally with a"
                + " `prompt` asking for the detail you need) to get a description from the Vision Group."
                + " Do not claim you inspected the pixels yourself.</system-reminder>"
        }
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
    struct ExecutionResult {
        let text: String
        let outcome: AgentRunOutcome
    }
    enum Path { case native, clarify, agent }
    enum Kind {
        // 待办 / 日程 / 行程自 1.75.2 起一律交给模型按日程规范录入，不再有本地直写的 kind。
        case savePhoto, setAlarm, toggleFlashlight
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

        var effectiveDayOffset: Int { min(366, max(0, dayOffset > 0 ? dayOffset : (tomorrow ? 1 : 0))) }

        var chip: String {
            switch kind {
            case .savePhoto: return "系统相册"
            case .setAlarm: return "系统闹钟"
            case .toggleFlashlight: return "手电筒"
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
            case .toggleFlashlight: return label == "off" ? "已关掉手电筒。" : "已打开手电筒。"
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
            case .toggleFlashlight: undo = "可用相反指令恢复"
            case .writeClipboard: undo = "可再次写入或清空剪贴板"
            case .readClipboard, .deviceInfo: undo = "只读操作，无需撤销"
            case nil: undo = "无需撤销"
            }
            return "\(summary ?? spoken())\n\n执行凭证\n- 路径：\(chip)\n- 核对：系统已确认完成\n- 撤销：\(undo)"
        }

        func failureReceipt(nextStep: String) -> String {
            "没有完成这项操作。\n\n执行凭证\n- 路径：\(chip)\n- 核对：系统未确认完成\n- 下一步：\(nextStep)"
        }

        func executionSuccess(summary: String? = nil) -> ExecutionResult {
            .init(text: receipt(summary: summary), outcome: .succeeded)
        }

        func executionFailure(nextStep: String) -> ExecutionResult {
            .init(text: failureReceipt(nextStep: nextStep), outcome: .failed)
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
        // 待办 / 日程 / 行程必须先分析日期、时间、提前量再写入：规则匹配认不全「明天下午三点半」这类说法，
        // 认不出时间就会建一条没日期的提醒（看起来像记在今天）。一律交给模型按日程录入规范处理。
        if isTodo(lower) || isCalendar(lower) || isTravel(lower) {
            return Decision(path: .agent, kind: nil, hour: nil, minute: nil, tomorrow: false, label: "")
        }
        if isAlarm(raw, lower: lower), let time = parseTime(raw, lower: lower) {
            return Decision(path: .native, kind: .setAlarm, hour: time.0, minute: time.1, tomorrow: isTomorrow(lower), dayOffset: dayOffset(lower), label: alarmLabel(raw))
        }
        return Decision(path: .agent, kind: nil, hour: nil, minute: nil, tomorrow: false, label: "")
    }

    /// 「记一下明天去北京的高铁」这类行程：交通工具 + 记录/提醒的意图。
    static func isTravel(_ lower: String) -> Bool {
        ["高铁", "动车", "火车", "航班", "飞机", "客车", "大巴", "轮船", "行程", "train", "flight", "bus", "trip"].contains(where: lower.contains)
            && ["记录", "记下", "记一下", "提醒", "行程", "日历", "别忘", "record", "remind", "schedule"].contains(where: lower.contains)
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
}
