import Foundation
import SwiftUI
import UIKit

// MARK: - Types

enum OffloadPermissionLevel: Int, CaseIterable {
    case bypass = 0
    case askOnce = 1
    case notAllowed = 2

    /// 设置页的选项名。必须走本地化:`Text(String)` 不查字符串表,原来中文界面里会露出英文。
    var displayName: String {
        switch self {
        case .bypass: return String(localized: "Bypass")
        case .askOnce: return String(localized: "Ask Once")
        case .notAllowed: return String(localized: "Not Allowed")
        }
    }
}

struct PermissionRequest: Identifiable {
    let id: String
    let commandName: String
    let displayLabel: String
    let description: String
    /// The full shell command string, e.g. "apple-healthkit query --type steps"
    let fullCommand: String
    /// Native argv is already tokenized; never split quoted values or shell-looking data.
    var nativeArguments: [String]? = nil

    /// Parse the command arguments into displayable key-value pairs.
    /// Handles patterns like: `command subcommand --key value --flag`.
    ///
    /// Only the FIRST shell command's tokens are surfaced — anything past a
    /// pipe / chain operator (`&&`, `||`, `;`, `|`) or a redirect (`>`,
    /// `>>`, `<`) belongs to a separate process or is plumbing the user
    /// shouldn't have to skim through to grant a permission. Without this
    /// gate the previous parser dumped the redirect target, the chained
    /// `python3 -c "..."` blob, and every word inside the quoted python
    /// snippet as `arg` rows, pushing the Allow / Deny buttons below the
    /// sheet's bottom edge.
    var parsedArguments: [(key: String, value: String)] {
        let parts = nativeArguments.map { [commandName] + $0 } ?? Self.firstCommandTokens(fullCommand)
        guard parts.count > 1 else { return [] }

        var result: [(key: String, value: String)] = []
        // First non-command token is the subcommand
        var idx = 1
        if idx < parts.count && !parts[idx].hasPrefix("-") {
            result.append((key: "Action", value: parts[idx]))
            idx += 1
        }
        while idx < parts.count {
            let token = parts[idx]
            if token.hasPrefix("--") || token.hasPrefix("-") {
                let key = token.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
                if idx + 1 < parts.count && !parts[idx + 1].hasPrefix("-") {
                    result.append((key: key, value: parts[idx + 1]))
                    idx += 2
                } else {
                    result.append((key: key, value: "true"))
                    idx += 1
                }
            } else {
                result.append((key: "arg", value: token))
                idx += 1
            }
        }
        return result
    }

    /// Whitespace-split the command but stop at the first shell separator so
    /// only the head command's tokens are returned. This is permissive about
    /// quoting (we don't try to honour `'...'` / `"..."` boundaries) — good
    /// enough for the permission-row preview where we just want to suppress
    /// the long tail past `&&`, redirects, etc. that confused users.
    private static let shellSeparators: Set<String> = [
        "&&", "||", ";", "|", ">", ">>", "<", "<<", "&",
    ]

    private static func firstCommandTokens(_ command: String) -> [String] {
        let raw = command.split(separator: " ").map(String.init)
        var head: [String] = []
        for token in raw {
            if shellSeparators.contains(token) { break }
            head.append(token)
        }
        return head
    }
}

// MARK: - Command Definitions

enum OffloadCommandCategory: String, CaseIterable {
    case privacy = "Privacy"
    case media = "Media"
    case system = "System"
}

struct OffloadCommandInfo {
    let name: String
    let category: OffloadCommandCategory
    /// Only privacy-sensitive commands appear in Settings
    let showInSettings: Bool

    // [T-static-let-localization-freeze] These two used to be stored Strings
    // built with String(localized:) inside `allCommands`, a `static let`. Swift
    // evaluates a static let ONCE per process, so after switching the in-app
    // language the whole Capabilities screen kept its launch-time language for
    // name + description while `actions` / `examplePrompt` (computed) switched
    // correctly — a half-translated screen. Storing the key and localizing on
    // read makes them follow the language like everything else.
    private let labelKey: String
    private let descriptionKey: String

    var displayLabel: String { String(localized: String.LocalizationValue(labelKey)) }
    var description: String {
        descriptionKey.isEmpty ? "" : String(localized: String.LocalizationValue(descriptionKey))
    }

    init(
        name: String,
        displayLabel: String,
        description: String,
        category: OffloadCommandCategory,
        showInSettings: Bool
    ) {
        self.name = name
        self.labelKey = displayLabel
        self.descriptionKey = description
        self.category = category
        self.showInSettings = showInSettings
    }

    var systemImage: String {
        switch name {
        case "apple-healthkit": return "heart.text.square"
        case "apple-calendar": return "calendar"
        case "apple-reminders": return "checklist"
        case "apple-photos": return "photo.on.rectangle"
        case "apple-location": return "location"
        case "apple-homekit": return "house"
        case "apple-clipboard": return "doc.on.clipboard"
        case "apple-nfc": return "wave.3.right"
        case "apple-bluetooth": return "antenna.radiowaves.left.and.right"
        case "apple-speak": return "speaker.wave.2"
        case "apple-speech": return "waveform"
        case "apple-player", "apple-media": return "play.square.stack"
        case "apple-device": return "iphone"
        case "apple-notification": return "bell"
        case "apple-alarm": return "alarm"
        case "apple-open": return "arrow.up.forward.app"
        case "apple-maps": return "map"
        case "apple-weather": return "cloud.sun"
        case "apple-nlp": return "text.magnifyingglass"
        case "apple-vision": return "viewfinder"
        case "apple-contacts": return "person.crop.circle"
        case "apple-files": return "folder"
        case "apple-camera": return "camera"
        case "apple-motion": return "figure.walk"
        case "apple-shortcuts": return "square.on.square"
        default: return "puzzlepiece.extension"
        }
    }

    var actions: [String] {
        switch name {
        case "apple-healthkit": return [String(localized: "Read health metrics"), String(localized: "Log supported samples"), String(localized: "Summarize trends")]
        case "apple-calendar": return [String(localized: "List events"), String(localized: "Check availability"), String(localized: "Create or update events")]
        case "apple-reminders": return [String(localized: "List reminders"), String(localized: "Create tasks"), String(localized: "Complete or reschedule items")]
        case "apple-photos": return [String(localized: "Search and inspect media"), String(localized: "Import or export files"), String(localized: "Delete only after explicit request")]
        case "apple-location": return [String(localized: "Read current location"), String(localized: "Resolve coordinates"), String(localized: "Use location in an Agent task")]
        case "apple-homekit": return [String(localized: "List homes and accessories"), String(localized: "Read device state"), String(localized: "Control supported accessories")]
        case "apple-clipboard": return [String(localized: "Read clipboard on request"), String(localized: "Write text or images")]
        case "apple-nfc": return [String(localized: "Read NDEF or supported tags"), String(localized: "Write NDEF tags"), String(localized: "Inspect supported smart cards")]
        case "apple-bluetooth": return [String(localized: "Scan nearby devices"), String(localized: "Connect to BLE peripherals"), String(localized: "Exchange supported data")]
        case "apple-speak": return [String(localized: "Speak Agent responses with system voices")]
        case "apple-speech": return [String(localized: "Transcribe microphone or audio input")]
        case "apple-player", "apple-media": return [String(localized: "Inspect media"), String(localized: "Control supported playback"), String(localized: "Work with the media library")]
        case "apple-device": return [String(localized: "Read safe device metadata and system state")]
        case "apple-notification": return [String(localized: "Schedule local notifications"), String(localized: "Remove pending notifications")]
        case "apple-alarm": return [String(localized: "Create and manage supported alarms")]
        case "apple-open": return [String(localized: "Open approved URLs and system destinations")]
        case "apple-maps": return [String(localized: "Search places"), String(localized: "Build routes"), String(localized: "Open map results")]
        case "apple-weather": return [String(localized: "Read current conditions and forecasts")]
        case "apple-nlp": return [String(localized: "Detect language"), String(localized: "Tokenize and analyze text")]
        case "apple-vision": return [String(localized: "OCR images"), String(localized: "Read barcodes"), String(localized: "Classify visual content")]
        case "apple-contacts": return [String(localized: "Search contacts"), String(localized: "Read contact details"), String(localized: "Create or update only with confirmation")]
        case "apple-files": return [String(localized: "List granted folders"), String(localized: "Ask you to pick a folder or file"), String(localized: "Re-authorize stale grants")]
        case "apple-camera": return [String(localized: "Open the camera for you to shoot"), String(localized: "Scan barcodes and QR codes"), String(localized: "Scan multi-page documents")]
        case "apple-motion": return [String(localized: "Read live step counts"), String(localized: "Summarize walking/driving activity")]
        case "apple-shortcuts": return [String(localized: "Run a shortcut by name"), String(localized: "Keep a registry of your shortcuts")]
        default: return []
        }
    }

    var examplePrompt: String {
        switch name {
        case "apple-healthkit": return String(localized: "Summarize my step count for the last seven days.")
        case "apple-calendar": return String(localized: "Find a free hour tomorrow afternoon and create a focus block.")
        case "apple-reminders": return String(localized: "Create a reminder to review this project tomorrow at 9 AM.")
        case "apple-photos": return String(localized: "Find the latest screenshots and export them to this workspace.")
        case "apple-location": return String(localized: "What useful places are near my current location?")
        case "apple-homekit": return String(localized: "Show the current state of my living room accessories.")
        case "apple-clipboard": return String(localized: "Summarize the text currently on my clipboard.")
        case "apple-nfc": return String(localized: "Read this NFC tag and explain its records.")
        case "apple-bluetooth": return String(localized: "List nearby Bluetooth devices I can connect to.")
        case "apple-speak": return String(localized: "Read the final answer aloud.")
        case "apple-speech": return String(localized: "Start voice input for a new task.")
        case "apple-player", "apple-media": return String(localized: "Pause the current audio and show what is playing.")
        case "apple-device": return String(localized: "Show storage and battery information available to the app.")
        case "apple-notification": return String(localized: "Notify me in twenty minutes to check this task.")
        case "apple-alarm": return String(localized: "Create an alarm for 7:30 tomorrow morning.")
        case "apple-open": return String(localized: "Open the settings page for background tasks.")
        case "apple-maps": return String(localized: "Plan a walking route to the nearest station.")
        case "apple-weather": return String(localized: "Will it rain here this evening?")
        case "apple-nlp": return String(localized: "Detect the language and key names in this text.")
        case "apple-vision": return String(localized: "Extract all text and QR codes from this image.")
        case "apple-contacts": return String(localized: "Find Zhang Wei's phone number in my contacts.")
        case "apple-files": return String(localized: "Ask me for a folder and organize the documents inside.")
        case "apple-camera": return String(localized: "Scan this receipt and extract the total.")
        case "apple-motion": return String(localized: "How many steps have I taken today?")
        case "apple-shortcuts": return String(localized: "Run my Good Morning shortcut.")
        default: return ""
        }
    }

    var dataDestination: String {
        switch name {
        case "apple-healthkit", "apple-calendar", "apple-reminders", "apple-photos",
             "apple-location", "apple-homekit", "apple-clipboard", "apple-nfc",
             "apple-bluetooth", "apple-speech", "apple-media", "apple-player",
             "apple-contacts", "apple-files", "apple-camera", "apple-motion":
            return String(localized: "Read on device. Results enter the current Agent conversation and are sent to its selected AI provider only when needed to answer the request.")
        default:
            return String(localized: "Processed on device. The selected AI provider receives only the tool result needed for the current task.")
        }
    }
}

// MARK: - Manager

@MainActor
final class OffloadPermissionManager: ObservableObject {
    static let shared = OffloadPermissionManager()

    /// Keys, not display strings — see OffloadCommandInfo.displayLabel.
    static let allCommands: [OffloadCommandInfo] = [
        // Privacy — user-configurable
        .init(name: "apple-healthkit", displayLabel: "HealthKit", description: "Steps, heart rate, sleep, and other authorized health samples", category: .privacy, showInSettings: true),
        .init(name: "apple-calendar", displayLabel: "Calendar", description: "Events, schedules, and calendar details", category: .privacy, showInSettings: true),
        .init(name: "apple-reminders", displayLabel: "Reminders", description: "Tasks, due dates, and reminder lists", category: .privacy, showInSettings: true),
        .init(name: "apple-photos", displayLabel: "Photos", description: "Photos, videos, and album metadata", category: .privacy, showInSettings: true),
        .init(name: "apple-location", displayLabel: "Location", description: "Current location and coordinates when requested", category: .privacy, showInSettings: true),
        .init(name: "apple-homekit", displayLabel: "HomeKit", description: "Smart home devices, rooms, and scenes", category: .privacy, showInSettings: true),
        .init(name: "apple-clipboard", displayLabel: "Clipboard", description: "Text and images copied to the clipboard", category: .privacy, showInSettings: true),
        .init(name: "apple-nfc", displayLabel: "NFC", description: "NFC tags, smart cards, and data written to nearby tags", category: .privacy, showInSettings: true),
        .init(name: "apple-bluetooth", displayLabel: "Bluetooth", description: "Nearby Bluetooth devices and data exchanged with them", category: .privacy, showInSettings: true),
        .init(name: "apple-contacts", displayLabel: "Contacts", description: "Contact names, phone numbers, emails, and groups", category: .privacy, showInSettings: true),
        .init(name: "apple-files", displayLabel: "Files", description: "Folders and files you grant through the system picker", category: .privacy, showInSettings: true),
        .init(name: "apple-camera", displayLabel: "Camera", description: "Photos, barcodes, and documents you capture in the camera UI", category: .privacy, showInSettings: true),
        .init(name: "apple-motion", displayLabel: "Motion", description: "Step counts and motion activity from the last 7 days", category: .privacy, showInSettings: true),
        .init(name: "apple-shortcuts", displayLabel: "Shortcuts", description: "Runs shortcuts you created in the Shortcuts app", category: .privacy, showInSettings: true),
        // Audio input, selected files and the media library can contain personal data.
        // Existing explicit settings are preserved; unset values default to Ask Once.
        .init(name: "apple-speech", displayLabel: "Speech", description: "Audio submitted for transcription", category: .privacy, showInSettings: true),
        .init(name: "apple-player", displayLabel: "Player", description: "Media files opened in the native player", category: .privacy, showInSettings: true),
        .init(name: "apple-media", displayLabel: "Media", description: "Media library and supported playback controls", category: .privacy, showInSettings: true),
        .init(name: "apple-speak", displayLabel: "Speak", description: "", category: .media, showInSettings: false),
        // System — no personal data, always bypass
        .init(name: "apple-device", displayLabel: "Device", description: "", category: .system, showInSettings: false),
        .init(name: "apple-notification", displayLabel: "Notification", description: "", category: .system, showInSettings: false),
        .init(name: "apple-alarm", displayLabel: "Alarm", description: "", category: .system, showInSettings: false),
        .init(name: "apple-open", displayLabel: "Open URL", description: "", category: .system, showInSettings: false),
        .init(name: "apple-maps", displayLabel: "Maps", description: "", category: .system, showInSettings: false),
        .init(name: "apple-weather", displayLabel: "Weather", description: "", category: .system, showInSettings: false),
        .init(name: "apple-nlp", displayLabel: "NLP", description: "", category: .system, showInSettings: false),
        .init(name: "apple-vision", displayLabel: "Vision", description: "", category: .system, showInSettings: false),
    ]

    @Published var pendingRequest: PermissionRequest?
    private var sessionGrants: [String: Set<String>] = [:]
    private var presenters: Set<String> = []
    private var waitingByRun: [String: Int] = [:]
    private let defaults = UserDefaults.standard
    private let logger = AppLogger(category: "OffloadPermission")
    private lazy var queue: OffloadPermissionQueue = {
        let queue = OffloadPermissionQueue()
        queue.onChange = { [weak self] pending in
            guard let self else { return }
            self.pendingRequest = pending.map { pending in
                let invocation = pending.invocation
                let info = Self.allCommands.first { $0.name == invocation.command }
                return PermissionRequest(
                    id: pending.id, commandName: invocation.registeredCommand,
                    displayLabel: info?.displayLabel ?? invocation.command,
                    description: info?.description ?? "",
                    fullCommand: ([invocation.registeredCommand] + invocation.arguments)
                        .map { "'" + $0.replacingOccurrences(of: "'", with: "'\"'\"'") + "'" }.joined(separator: " "),
                    nativeArguments: invocation.arguments
                )
            }
        }
        return queue
    }()

    private init() {}

    private func defaultsKey(for command: String, action: String? = nil) -> String {
        "offloadPermission.\(command)" + (action.map { ".action.\($0)" } ?? "")
    }

    func permissionLevel(for command: String, action: String? = nil) -> OffloadPermissionLevel {
        let stored = defaults.object(forKey: defaultsKey(for: command)) as? Int
        let isPrivacy = Self.allCommands.first(where: { $0.name == command })?.category == .privacy
        let family = OffloadPermissionPolicy.resolvedLevel(stored: stored, isPrivacy: isPrivacy)
        let validFamily = OffloadPermissionLevel(rawValue: family)?.rawValue ?? (isPrivacy ? 1 : 0)
        let actionOverride = action.flatMap { defaults.object(forKey: defaultsKey(for: command, action: $0)) as? Int }
        return OffloadPermissionLevel(rawValue: OffloadPermissionPolicy.resolvedNativeLevel(
            family: validFamily, actionOverride: actionOverride
        )) ?? .askOnce
    }

    func setPermissionLevel(_ level: OffloadPermissionLevel, for command: String, action: String? = nil) {
        defaults.set(level.rawValue, forKey: defaultsKey(for: command, action: action))
        // A settings change invalidates prior grants immediately, including a
        // decision already visible in the sheet. The continuation rechecks too.
        for sid in Array(sessionGrants.keys) {
            sessionGrants[sid] = sessionGrants[sid]?.filter { !$0.hasPrefix(command + ".") }
        }
        queue.cancel(where: { pending in
            let invocation = pending.invocation
            return (invocation.command == command || invocation.registeredCommand == command)
                && (action == nil || invocation.action == action)
        }, decision: level == .notAllowed ? .disabled : .cancelled)
    }

    /// 能力自检专用的会话 id(CapabilitySelfTestView 用它跑命令)。每个进程随机一段,
    /// 别处猜不到;以这个前缀开头的 id 不能当会话用(见 isReservedSessionId)。
    nonisolated static let selfTestSessionPrefix = "__capability_selftest__"
    nonisolated static let selfTestSessionId = selfTestSessionPrefix + UUID().uuidString.lowercased()

    /// 自检保留的 id:不能被 minis-sessions-cli、深链当成聊天会话打开或发消息。
    nonisolated static func isReservedSessionId(_ id: String) -> Bool {
        id.hasPrefix(selfTestSessionPrefix)
    }

    func setAllBypass() {
        for command in Self.allCommands { setPermissionLevel(.bypass, for: command.name) }
        sessionGrants.removeAll()
    }

    /// Installed by the single root presenter. A chat, terminal, or native
    /// entry may request consent; a hidden/locked/background app cannot.
    func setPresenter(_ id: String, available: Bool) {
        if available { presenters.insert(id) } else { presenters.remove(id) }
        if presenters.isEmpty {
            queue.cancel(where: { _ in true }, decision: .needsForeground)
        }
    }

    func authorize(command: String, action: String, arguments: [String] = [],
                   sessionId: String?) async -> OffloadPermissionDecision {
        await authorize(command: command, arguments: [action] + arguments, sessionId: sessionId)
    }

    /// One policy for guest execve and direct Swift/native routes. Session IDs
    /// on the guest path come from the host-issued fs_context, never env/argv.
    func authorize(command: String, arguments: [String], sessionId: String?,
                   requestID: String = UUID().uuidString,
                   isCancelled: @escaping () -> Bool = { false }) async -> OffloadPermissionDecision {
        guard Self.allCommands.contains(where: { $0.name == command }) else { return .unknownCapability }
        let invocation = OffloadPermissionInvocation(command: command, arguments: arguments)
        let session = sessionId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let sid = session.flatMap { $0.isEmpty ? nil : $0 }
        if Task.isCancelled || isCancelled() { return .cancelled }
        if permissionLevel(for: command) == .notAllowed { return .disabled }
        let level = permissionLevel(for: invocation.command, action: invocation.action)
        if level == .notAllowed { return .disabled }
        // 能力自检:你按了「开始自检」,跑的是 App 内置的只读探测(会话 id 由宿主发放,Agent 冒充不了),
        // 不再逐项等审批——以前审批框弹不到设置页上面,每项干等 25 秒后报「在等系统授权」。
        if sid == Self.selfTestSessionId, CapabilitySelfTest.shared.isRunning { return .allowed }
        // [T-full-auto] 全自动:「询问」一律放行;你设成「不允许」的上面已经挡掉。
        // 只对正在跑的 Agent 回合生效:你自己在终端里敲(或被链接预填)的命令照旧先问。
        if FullAutoGate.isOn, let sid, SessionActivityTracker.shared.isActive(sid) {
            FullAutoGate.announce("\(command) \(arguments.prefix(3).joined(separator: " "))", sessionId: sid)
            return .allowed
        }
        if level == .bypass || invocation.isStatusOnly { return .allowed }
        if let sid, sessionGrants[sid]?.contains(invocation.grantScope) == true { return .allowed }
        guard UIApplication.shared.applicationState == .active, !presenters.isEmpty else { return .needsForeground }

        let tracker = SessionActivityTracker.shared
        let requestingRunID = sid.flatMap { tracker.isActive($0) ? tracker.currentRunId(for: $0) : nil }
        if let sid, let requestingRunID {
            waitingByRun[requestingRunID, default: 0] += 1
            tracker.updateActivityPhase(sid, phase: .waitingForPermission, reason: .permissionApproval)
        }
        defer {
            if let sid, let requestingRunID {
                let remaining = max(0, (waitingByRun[requestingRunID] ?? 1) - 1)
                if remaining == 0 {
                    waitingByRun.removeValue(forKey: requestingRunID)
                    if OffloadPermissionPolicy.isSameActiveRun(requestedRunID: requestingRunID,
                        currentRunID: tracker.currentRunId(for: sid), isActive: tracker.isActive(sid)) {
                        tracker.updateActivityPhase(sid, phase: .usingTool)
                    }
                } else { waitingByRun[requestingRunID] = remaining }
            }
        }
        let decision = await queue.enqueue(.init(id: requestID, invocation: invocation, sessionID: sid))
        if Task.isCancelled || isCancelled() { return .cancelled }
        if let sid, let requestingRunID,
           !OffloadPermissionPolicy.isSameActiveRun(requestedRunID: requestingRunID,
               currentRunID: tracker.currentRunId(for: sid), isActive: tracker.isActive(sid)) { return .cancelled }
        guard decision == .allowed else { return decision }
        // Revocation wins over a late response from the former sheet.
        if permissionLevel(for: command) == .notAllowed
            || permissionLevel(for: invocation.command, action: invocation.action) == .notAllowed { return .disabled }
        guard UIApplication.shared.applicationState == .active, !presenters.isEmpty else { return .needsForeground }
        // Context-free terminal/native invocations get one approval only; never
        // share a process-wide "global session" grant with unrelated callers.
        if let sid { sessionGrants[sid, default: []].insert(invocation.grantScope) }
        logger.info("Native permission granted: \(invocation.command).\(invocation.action)")
        return .allowed
    }

    func respond(to requestId: String, allowed: Bool) {
        queue.respond(id: requestId, decision: allowed ? .allowed : .denied)
    }

    func cancelRequest(_ id: String) {
        queue.cancel(where: { $0.id == id }, decision: .cancelled)
    }

    func resetSessionGrants(for sessionId: String) {
        sessionGrants.removeValue(forKey: sessionId)
        queue.cancel(where: { $0.sessionID == sessionId }, decision: .cancelled)
    }
}

/// A native worker may cancel while its MainActor hop is still queued. The
/// synchronous flag closes that race before a permission sheet can be created.
@objc final class NativeOffloadPermissionOperation: NSObject, @unchecked Sendable {
    let id = UUID().uuidString
    private let lock = NSLock()
    private var cancelled = false
    var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return cancelled
    }

    @objc func cancel() {
        lock.lock()
        cancelled = true
        lock.unlock()
        Task { @MainActor in OffloadPermissionManager.shared.cancelRequest(self.id) }
    }
}

@objc final class NativeOffloadPermissionBridge: NSObject {
    @objc(authorizeCommand:arguments:fsContext:completion:)
    static func authorize(command: String, arguments: [String], fsContext: UInt64,
                          completion: @escaping (String?, String?) -> Void) -> NativeOffloadPermissionOperation {
        let operation = NativeOffloadPermissionOperation()
        // Resolve the trusted host token before hopping to the UI actor. Unknown
        // tokens are deliberately context-free, never the currently visible chat.
        let sid = MinisFsRouter.shared.sid(for: fsContext)
        Task { @MainActor in
            let result = await OffloadPermissionManager.shared.authorize(
                command: command, arguments: arguments, sessionId: sid,
                requestID: operation.id, isCancelled: { operation.isCancelled }
            )
            completion(result.errorCode, result.message(command: command))
        }
        return operation
    }
}
