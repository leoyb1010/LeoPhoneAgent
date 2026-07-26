import Foundation
import SwiftUI

// MARK: - Types

enum OffloadPermissionLevel: Int, CaseIterable {
    case bypass = 0
    case askOnce = 1
    case notAllowed = 2

    var displayName: String {
        switch self {
        case .bypass: return "Bypass"
        case .askOnce: return "Ask Once"
        case .notAllowed: return "Not Allowed"
        }
    }
}

enum PermissionResult {
    case allowed
    case denied(String)
}

struct PermissionRequest: Identifiable {
    let id: String
    let commandName: String
    let displayLabel: String
    let description: String
    /// The full shell command string, e.g. "apple-healthkit query --type steps"
    let fullCommand: String
    let continuation: CheckedContinuation<Bool, Never>

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
        let parts = Self.firstCommandTokens(fullCommand)
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
    let displayLabel: String
    let description: String
    let category: OffloadCommandCategory
    /// Only privacy-sensitive commands appear in Settings
    let showInSettings: Bool

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
        default: return "puzzlepiece.extension"
        }
    }

    var actions: [String] {
        switch name {
        case "apple-healthkit": return ["Read health metrics", "Log supported samples", "Summarize trends"]
        case "apple-calendar": return ["List events", "Check availability", "Create or update events"]
        case "apple-reminders": return ["List reminders", "Create tasks", "Complete or reschedule items"]
        case "apple-photos": return ["Search and inspect media", "Import or export files", "Delete only after explicit request"]
        case "apple-location": return ["Read current location", "Resolve coordinates", "Use location in an Agent task"]
        case "apple-homekit": return ["List homes and accessories", "Read device state", "Control supported accessories"]
        case "apple-clipboard": return ["Read clipboard on request", "Write text or images"]
        case "apple-nfc": return ["Read NDEF or supported tags", "Write NDEF tags", "Inspect supported smart cards"]
        case "apple-bluetooth": return ["Scan nearby devices", "Connect to BLE peripherals", "Exchange supported data"]
        case "apple-speak": return ["Speak Agent responses with system voices"]
        case "apple-speech": return ["Transcribe microphone or audio input"]
        case "apple-player", "apple-media": return ["Inspect media", "Control supported playback", "Work with the media library"]
        case "apple-device": return ["Read safe device metadata and system state"]
        case "apple-notification": return ["Schedule local notifications", "Remove pending notifications"]
        case "apple-alarm": return ["Create and manage supported alarms"]
        case "apple-open": return ["Open approved URLs and system destinations"]
        case "apple-maps": return ["Search places", "Build routes", "Open map results"]
        case "apple-weather": return ["Read current conditions and forecasts"]
        case "apple-nlp": return ["Detect language", "Tokenize and analyze text"]
        case "apple-vision": return ["OCR images", "Read barcodes", "Classify visual content"]
        default: return []
        }
    }

    var examplePrompt: String {
        switch name {
        case "apple-healthkit": return "Summarize my step count for the last seven days."
        case "apple-calendar": return "Find a free hour tomorrow afternoon and create a focus block."
        case "apple-reminders": return "Create a reminder to review this project tomorrow at 9 AM."
        case "apple-photos": return "Find the latest screenshots and export them to this workspace."
        case "apple-location": return "What useful places are near my current location?"
        case "apple-homekit": return "Show the current state of my living room accessories."
        case "apple-clipboard": return "Summarize the text currently on my clipboard."
        case "apple-nfc": return "Read this NFC tag and explain its records."
        case "apple-bluetooth": return "List nearby Bluetooth devices I can connect to."
        case "apple-speak": return "Read the final answer aloud."
        case "apple-speech": return "Start voice input for a new task."
        case "apple-player", "apple-media": return "Pause the current audio and show what is playing."
        case "apple-device": return "Show storage and battery information available to the app."
        case "apple-notification": return "Notify me in twenty minutes to check this task."
        case "apple-alarm": return "Create an alarm for 7:30 tomorrow morning."
        case "apple-open": return "Open the settings page for background tasks."
        case "apple-maps": return "Plan a walking route to the nearest station."
        case "apple-weather": return "Will it rain here this evening?"
        case "apple-nlp": return "Detect the language and key names in this text."
        case "apple-vision": return "Extract all text and QR codes from this image."
        default: return ""
        }
    }

    var dataDestination: String {
        switch name {
        case "apple-healthkit", "apple-calendar", "apple-reminders", "apple-photos",
             "apple-location", "apple-homekit", "apple-clipboard", "apple-nfc",
             "apple-bluetooth", "apple-speech", "apple-media", "apple-player":
            return "Read on device. Results enter the current Agent conversation and are sent to its selected AI provider only when needed to answer the request."
        default:
            return "Processed on device. The selected AI provider receives only the tool result needed for the current task."
        }
    }
}

// MARK: - Manager

/// Fallback session id used when an offload permission check has no chat session
/// context (e.g. invocations outside the chat flow, or before a session id has
/// been assigned). Mirrors the Android constant `OFFLOAD_GLOBAL_SESSION_ID`
/// (commit 20d8e68) so per-session grants stay wire-compatible across platforms.
let OFFLOAD_GLOBAL_SESSION_ID = "offload-global"

@MainActor
final class OffloadPermissionManager: ObservableObject {
    static let shared = OffloadPermissionManager()

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
        // Media — no personal data, always bypass
        .init(name: "apple-speak", displayLabel: "Speak", description: "", category: .media, showInSettings: false),
        .init(name: "apple-speech", displayLabel: "Speech", description: "", category: .media, showInSettings: false),
        .init(name: "apple-player", displayLabel: "Player", description: "", category: .media, showInSettings: false),
        .init(name: "apple-media", displayLabel: "Media", description: "", category: .media, showInSettings: false),
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

    /// Per-session "Ask Once" grants: [sessionId: Set<commandName>]
    private var sessionGrants: [String: Set<String>] = [:]

    private let defaults = UserDefaults.standard
    private let logger = AppLogger(category: "OffloadPermission")

    private init() {}

    // MARK: - Storage

    private func defaultsKey(for command: String) -> String {
        "offloadPermission.\(command)"
    }

    func permissionLevel(for command: String) -> OffloadPermissionLevel {
        let raw = defaults.integer(forKey: defaultsKey(for: command))
        return OffloadPermissionLevel(rawValue: raw) ?? .bypass
    }

    func setPermissionLevel(_ level: OffloadPermissionLevel, for command: String) {
        defaults.set(level.rawValue, forKey: defaultsKey(for: command))
    }

    func setAllBypass() {
        for cmd in Self.allCommands {
            setPermissionLevel(.bypass, for: cmd.name)
        }
        sessionGrants.removeAll()
    }

    // MARK: - Command Extraction

    static func extractOffloadCommand(from shellCommand: String) -> String? {
        let trimmed = shellCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        let firstToken = trimmed.split(separator: " ", maxSplits: 1).first.map(String.init) ?? trimmed
        // Check if this token matches a known offload command
        if allCommands.contains(where: { $0.name == firstToken }) {
            return firstToken
        }
        return nil
    }

    // MARK: - Permission Check

    func checkPermission(for command: String, sessionId: String?, fullCommand: String = "") async -> PermissionResult {
        // Mirror Android: prefer the caller-supplied session id; fall back to the
        // global bucket when the chat hasn't bound a session yet (or when invoked
        // outside chat). This keeps `Ask Once` grants per-session when possible
        // while still working for non-chat callers.
        let trimmed = sessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let sessionId = trimmed.isEmpty ? OFFLOAD_GLOBAL_SESSION_ID : trimmed
        let level = permissionLevel(for: command)

        switch level {
        case .bypass:
            return .allowed

        case .notAllowed:
            logger.info("Permission denied (Not Allowed): \(command)")
            return .denied("Permission denied: the user has disabled '\(command)'. To enable it, go to Settings > Permissions or tap: [Open Permissions](leophoneagent://settings/permissions)")

        case .askOnce:
            // Check session grant
            if sessionGrants[sessionId]?.contains(command) == true {
                return .allowed
            }

            let cmdInfo = Self.allCommands.first(where: { $0.name == command })
            let displayLabel = cmdInfo?.displayLabel ?? command
            let description = cmdInfo?.description ?? ""

            SessionActivityTracker.shared.updateActivityPhase(
                sessionId,
                phase: .waitingForPermission,
                reason: .permissionApproval
            )

            let allowed = await withCheckedContinuation { continuation in
                let request = PermissionRequest(
                    id: UUID().uuidString,
                    commandName: command,
                    displayLabel: displayLabel,
                    description: description,
                    fullCommand: fullCommand,
                    continuation: continuation
                )
                self.pendingRequest = request

                // 30s timeout
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 30_000_000_000)
                    if self.pendingRequest?.id == request.id {
                        self.pendingRequest = nil
                        continuation.resume(returning: false)
                    }
                }
            }

            // The permission decision closes the wait regardless of outcome.
            // The tool result itself will carry denial details when applicable.
            SessionActivityTracker.shared.updateActivityPhase(
                sessionId,
                phase: .usingTool
            )

            if allowed {
                sessionGrants[sessionId, default: []].insert(command)
                logger.info("Permission granted (Ask Once): \(command)")
                return .allowed
            } else {
                logger.info("Permission denied (Ask Once): \(command)")
                if sessionGrants[sessionId]?.contains(command) == true {
                    // Was granted via timeout race — treat as denied
                    return .denied("Permission denied: authorization for '\(command)' timed out. To change permissions: [Open Permissions](leophoneagent://settings/permissions)")
                }
                return .denied("Permission denied: the user declined '\(command)' for this session. To change permissions: [Open Permissions](leophoneagent://settings/permissions)")
            }
        }
    }

    // MARK: - UI Response

    func respond(to requestId: String, allowed: Bool) {
        guard let request = pendingRequest, request.id == requestId else { return }
        pendingRequest = nil
        request.continuation.resume(returning: allowed)
    }

    // MARK: - Session Reset

    func resetSessionGrants(for sessionId: String) {
        sessionGrants.removeValue(forKey: sessionId)
    }
}
