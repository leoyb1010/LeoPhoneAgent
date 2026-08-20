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

/// Fallback session id used when an offload permission check has no chat session
/// context (e.g. invocations outside the chat flow, or before a session id has
/// been assigned). Mirrors the Android constant `OFFLOAD_GLOBAL_SESSION_ID`
/// (commit 20d8e68) so per-session grants stay wire-compatible across platforms.
let OFFLOAD_GLOBAL_SESSION_ID = "offload-global"

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
    /// Extra ask-once prompts waiting behind `pendingRequest`. A second
    /// concurrent `shell_execute` used to overwrite the first continuation.
    private var pendingQueue: [PermissionRequest] = []

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
        let key = defaultsKey(for: command)
        let stored = defaults.object(forKey: key) as? Int
        let isPrivacy = Self.allCommands.first(where: { $0.name == command })?.category == .privacy
        let raw = OffloadPermissionPolicy.resolvedLevel(stored: stored, isPrivacy: isPrivacy)
        return OffloadPermissionLevel(rawValue: raw) ?? (isPrivacy ? .askOnce : .bypass)
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
        OffloadPermissionPolicy.extractOffloadCommand(
            from: shellCommand,
            known: allCommands.map(\.name)
        )
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
            return .denied(OffloadPermissionPolicy.disabledDenial(command: command))

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
                if self.pendingRequest == nil {
                    self.pendingRequest = request
                } else {
                    self.pendingQueue.append(request)
                }

                // 30s timeout
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 30_000_000_000)
                    if self.pendingRequest?.id == request.id {
                        self.pendingRequest = nil
                        continuation.resume(returning: false)
                        self.promoteNextPermissionRequest()
                    } else if let idx = self.pendingQueue.firstIndex(where: { $0.id == request.id }) {
                        self.pendingQueue.remove(at: idx)
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
                    return .denied(OffloadPermissionPolicy.timeoutDenial(command: command))
                }
                return .denied(OffloadPermissionPolicy.declinedDenial(command: command))
            }
        }
    }

    // MARK: - UI Response

    func respond(to requestId: String, allowed: Bool) {
        guard let request = pendingRequest, request.id == requestId else { return }
        pendingRequest = nil
        request.continuation.resume(returning: allowed)
        promoteNextPermissionRequest()
    }

    private func promoteNextPermissionRequest() {
        guard pendingRequest == nil, !pendingQueue.isEmpty else { return }
        pendingRequest = pendingQueue.removeFirst()
    }

    // MARK: - Session Reset

    func resetSessionGrants(for sessionId: String) {
        sessionGrants.removeValue(forKey: sessionId)
    }
}
