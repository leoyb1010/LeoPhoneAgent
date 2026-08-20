import AVFoundation
import Contacts
import CoreBluetooth
import CoreLocation
import CoreMotion
import CoreNFC
import EventKit
import HealthKit
import MediaPlayer
import Photos
import Speech
import SwiftUI
import UserNotifications

struct OffloadPermissionSettingsView: View {
    @ObservedObject private var manager = OffloadPermissionManager.shared
    @ObservedObject private var configGate = MinisConfigPermissionStore.shared
    @ObservedObject private var correctionConsent = VoiceCorrectionCollectionConsent.shared
    @State private var showClearCorrectionConfirm = false
    @State private var correctionDataCleared = false

    var body: some View {
        List {
            Section {
                NavigationLink {
                    NativeCapabilitiesCenterView()
                } label: {
                    Label("Apple Capabilities", systemImage: "square.grid.2x2")
                }
            } footer: {
                Text("Review every native capability, its current system access, available actions, Agent policy, and data destination.")
            }

            Section("Background") {
                NavigationLink {
                    EnhancedBackgroundSettingsView()
                } label: {
                    Label("Background", systemImage: "location.circle.fill")
                }
            }

            Section {
                Toggle("Allow minis-config", isOn: $configGate.enabled)
            } header: {
                Text("Configuration Tool")
            } footer: {
                Text("When disabled, the agent cannot read or modify any settings via minis-config. The change history at Logs → Config Changes remains accessible. The agent will receive a permission_denied error and can guide you via deep links instead.")
            }

            Section("Privacy") {
                ForEach(settingsCommands, id: \.name) { cmd in
                    CommandPermissionRow(command: cmd)
                }
            }

            Section {
                Toggle(String(localized: "Collect voice correction data",
                              comment: "Permissions: toggle for voice-correction learning data collection"),
                       isOn: $correctionConsent.isEnabled)
                Button(role: .destructive) {
                    showClearCorrectionConfirm = true
                } label: {
                    Label(String(localized: "Clear Collected Data",
                                 comment: "Permissions: wipe voice-correction learning data"),
                          systemImage: "trash")
                }
            } header: {
                Text("Voice Correction Learning")
            } footer: {
                Text("When enabled, your manual fixes to voice transcripts (original → corrected pairs), accepted/rejected AI corrections, and frequently typed terms are stored in a local on-device database to make future voice corrections smarter. Nothing is uploaded. Default is off; existing data stays until you clear it.")
            }
            .confirmationDialog(
                String(localized: "Clear all collected voice correction data?",
                       comment: "Permissions: confirm wipe of correction learning data"),
                isPresented: $showClearCorrectionConfirm,
                titleVisibility: .visible
            ) {
                Button(String(localized: "Clear All", comment: "Confirm clearing correction data"),
                       role: .destructive) {
                    Task {
                        if let db = VoiceCorrectionDB.shared {
                            await db.clearTable("confusion_dictionary")
                            await db.clearTable("typed_vocabulary")
                            await db.clearTable("correction_events")
                        }
                        correctionDataCleared = true
                    }
                }
                Button(String(localized: "Cancel", comment: "Cancel"), role: .cancel) {}
            }
            .alert(String(localized: "Voice correction data cleared",
                          comment: "Permissions: wipe done confirmation"),
                   isPresented: $correctionDataCleared) {
                Button("OK") {}
            }
        }
        .navigationTitle("Permissions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Set All Bypass") {
                    manager.setAllBypass()
                    // The minis-config master switch is a separate
                    // store from OffloadPermissionManager (different
                    // subsystem) so its own setAllBypass doesn't touch
                    // it. Flip it on here so "Set All Bypass" really
                    // does enable everything the user can see on this
                    // screen.
                    configGate.enabled = true
                }
            }
        }
    }

    private var settingsCommands: [OffloadCommandInfo] {
        OffloadPermissionManager.allCommands.filter { $0.showInSettings }
    }
}

// MARK: - Native capabilities center

private enum CapabilityAuthorizationState: Equatable {
    case authorized
    case limited
    case notDetermined
    case denied
    case unavailable
    case ready
    case managed
    case unknown

    var title: String {
        switch self {
        case .authorized: return "Authorized"
        case .limited: return "Limited"
        case .notDetermined: return "Ask When Used"
        case .denied: return "Denied"
        case .unavailable: return "Unavailable"
        case .ready: return "Integrated"
        case .managed: return "Per-Item Access"
        case .unknown: return "Checked on Use"
        }
    }

    var systemImage: String {
        switch self {
        case .authorized, .ready: return "checkmark.circle.fill"
        case .limited, .managed: return "circle.lefthalf.filled"
        case .notDetermined, .unknown: return "questionmark.circle"
        case .denied: return "xmark.circle.fill"
        case .unavailable: return "minus.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .authorized, .ready: return .green
        case .limited, .managed, .notDetermined, .unknown: return .orange
        case .denied: return .red
        case .unavailable: return .secondary
        }
    }

    var needsAttention: Bool {
        self == .denied || self == .unavailable
    }
}

@MainActor
private final class NativeCapabilityProbe: ObservableObject {
    @Published private(set) var states: [String: CapabilityAuthorizationState] = [:]
    @Published private(set) var isRefreshing = false

    func state(for key: String) -> CapabilityAuthorizationState {
        states[key] ?? .ready
    }

    func refresh() async {
        isRefreshing = true
        var next: [String: CapabilityAuthorizationState] = [:]

        next["apple-healthkit"] = HKHealthStore.isHealthDataAvailable() ? .managed : .unavailable
        next["apple-calendar"] = eventState(EKEventStore.authorizationStatus(for: .event))
        next["apple-reminders"] = eventState(EKEventStore.authorizationStatus(for: .reminder))
        next["apple-photos"] = photoState(PHPhotoLibrary.authorizationStatus(for: .readWrite))
        next["apple-location"] = locationState(CLLocationManager().authorizationStatus)
        // HomeKit doesn't provide a static probe. Creating HMHomeManager solely
        // for status can trigger access work, so this center remains read-only.
        next["apple-homekit"] = .unknown
        next["apple-clipboard"] = .ready
        next["apple-nfc"] = NFCNDEFReaderSession.readingAvailable ? .ready : .unavailable
        next["apple-bluetooth"] = bluetoothState(CBManager.authorization)
        next["apple-speak"] = .ready
        next["apple-speech"] = speechState()
        next["apple-player"] = mediaState(MPMediaLibrary.authorizationStatus())
        next["apple-media"] = next["apple-player"]
        next["apple-device"] = .ready
        next["apple-alarm"] = .ready
        next["apple-open"] = .ready
        next["apple-maps"] = .ready
        next["apple-weather"] = .ready
        next["apple-nlp"] = .ready
        next["apple-vision"] = .ready
        next["apple-contacts"] = contactsState(CNContactStore.authorizationStatus(for: .contacts))
        next["apple-camera"] = captureState(AVCaptureDevice.authorizationStatus(for: .video))
        next["apple-files"] = .unknown
        next["apple-motion"] = CMMotionActivityManager.isActivityAvailable() ? .ready : .unavailable
        next["apple-shortcuts"] = .ready

        let notificationSettings = await UNUserNotificationCenter.current().notificationSettings()
        next["apple-notification"] = notificationState(notificationSettings.authorizationStatus)

        next["camera"] = next["apple-camera"] ?? captureState(AVCaptureDevice.authorizationStatus(for: .video))
        next["microphone"] = captureState(AVCaptureDevice.authorizationStatus(for: .audio))
        next["shortcuts"] = next["apple-shortcuts"] ?? .ready
        next["widget"] = .ready
        next["icloud"] = FileManager.default.ubiquityIdentityToken == nil ? .limited : .ready
        next["files-share"] = .ready
        if #available(iOS 26.0, *) {
            next["background-processing"] = .ready
        } else {
            next["background-processing"] = .limited
        }

        states = next
        isRefreshing = false
    }

    private func eventState(_ status: EKAuthorizationStatus) -> CapabilityAuthorizationState {
        if #available(iOS 17.0, *) {
            switch status {
            case .notDetermined: return .notDetermined
            case .restricted, .denied: return .denied
            case .fullAccess: return .authorized
            case .writeOnly: return .limited
            @unknown default: return .limited
            }
        } else {
            switch status {
            case .notDetermined: return .notDetermined
            case .restricted, .denied: return .denied
            case .authorized, .fullAccess: return .authorized
            case .writeOnly: return .limited
            @unknown default: return .limited
            }
        }
    }

    private func photoState(_ status: PHAuthorizationStatus) -> CapabilityAuthorizationState {
        switch status {
        case .authorized: return .authorized
        case .limited: return .limited
        case .notDetermined: return .notDetermined
        case .restricted, .denied: return .denied
        @unknown default: return .limited
        }
    }

    private func locationState(_ status: CLAuthorizationStatus) -> CapabilityAuthorizationState {
        switch status {
        case .authorizedAlways, .authorizedWhenInUse: return .authorized
        case .notDetermined: return .notDetermined
        case .restricted, .denied: return .denied
        @unknown default: return .limited
        }
    }

    private func bluetoothState(_ status: CBManagerAuthorization) -> CapabilityAuthorizationState {
        switch status {
        case .allowedAlways: return .authorized
        case .notDetermined: return .notDetermined
        case .restricted, .denied: return .denied
        @unknown default: return .limited
        }
    }

    private func mediaState(_ status: MPMediaLibraryAuthorizationStatus) -> CapabilityAuthorizationState {
        switch status {
        case .authorized: return .authorized
        case .notDetermined: return .notDetermined
        case .restricted, .denied: return .denied
        @unknown default: return .limited
        }
    }

    private func captureState(_ status: AVAuthorizationStatus) -> CapabilityAuthorizationState {
        switch status {
        case .authorized: return .authorized
        case .notDetermined: return .notDetermined
        case .restricted, .denied: return .denied
        @unknown default: return .limited
        }
    }

    private func contactsState(_ status: CNAuthorizationStatus) -> CapabilityAuthorizationState {
        switch status {
        case .authorized: return .authorized
        case .limited: return .limited
        case .notDetermined: return .notDetermined
        case .restricted, .denied: return .denied
        @unknown default: return .limited
        }
    }

    private func notificationState(_ status: UNAuthorizationStatus) -> CapabilityAuthorizationState {
        switch status {
        case .authorized, .provisional, .ephemeral: return .authorized
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        @unknown default: return .limited
        }
    }

    private func speechState() -> CapabilityAuthorizationState {
        let speech = SFSpeechRecognizer.authorizationStatus()
        let microphone = AVCaptureDevice.authorizationStatus(for: .audio)
        if speech == .denied || speech == .restricted || microphone == .denied || microphone == .restricted {
            return .denied
        }
        if speech == .authorized && microphone == .authorized { return .authorized }
        return .notDetermined
    }
}

private struct SupplementalCapability: Identifiable {
    let id: String
    let title: String
    let systemImage: String
    let summary: String
    let actions: [String]
    let dataDestination: String

    static let all: [SupplementalCapability] = [
        .init(id: "camera", title: "Camera", systemImage: "camera", summary: "Capture images for a conversation", actions: ["Take a photo", "Scan visual context", "Attach media to a task"], dataDestination: "Captured media stays in the current conversation and is sent only to its selected AI provider when used."),
        .init(id: "microphone", title: "Microphone", systemImage: "mic", summary: "Voice input and audio capture", actions: ["Start voice input", "Transcribe speech", "Attach recorded audio"], dataDestination: "Audio is processed by the configured transcription path. The transcript enters the current conversation."),
        .init(id: "shortcuts", title: "Siri & Shortcuts", systemImage: "shortcuts", summary: "Start, inspect, and continue Agent tasks", actions: ["Ask LeoPhoneAgent", "Run a quick task", "List and open sessions"], dataDestination: "Shortcut inputs are handled by the app and the AI provider selected for the resulting session."),
        .init(id: "widget", title: "Widgets & Live Activities", systemImage: "rectangle.3.group", summary: "Home Screen, Lock Screen, and Dynamic Island status", actions: ["See task state", "Open the active session", "Jump to voice input"], dataDestination: "A privacy-aware task snapshot is stored in the LeoPhoneAgent App Group. Live Activity content follows Task Status Privacy."),
        .init(id: "icloud", title: "iCloud & CloudKit", systemImage: "icloud", summary: "Optional session, settings, and file synchronization", actions: ["Sync supported records", "Back up app data", "Continue across personal devices"], dataDestination: "When enabled, supported records and provider configuration are stored in your private iCloud account."),
        .init(id: "files-share", title: "Files & Share", systemImage: "folder.badge.plus", summary: "Files app integration and Share Sheet intake", actions: ["Browse app files", "Import shared content", "Expose supported workspace folders"], dataDestination: "Files remain in the app container, shared App Group, or folders you explicitly select."),
        .init(id: "background-processing", title: "Background Processing", systemImage: "clock.arrow.circlepath", summary: "Continue user-started Agent work after locking", actions: ["Report progress", "Handle system expiration", "Resume interrupted work"], dataDestination: "Task state remains device-local. iOS can still stop work under resource pressure; LeoPhoneAgent preserves a recovery state."),
    ]
}

private struct NativeCapabilitiesCenterView: View {
    @StateObject private var probe = NativeCapabilityProbe()

    private var attentionCount: Int {
        probe.states.values.filter(\.needsAttention).count
    }

    var body: some View {
        List {
            Section {
                LabeledContent("Native integrations", value: "\(OffloadPermissionManager.allCommands.count + SupplementalCapability.all.count)")
                LabeledContent("Needs attention", value: "\(attentionCount)")
                    .foregroundStyle(attentionCount == 0 ? Color.primary : Color.orange)
            } footer: {
                Text("Status checks never request access. LeoPhoneAgent asks only when you use a capability. Health read access is selected per data type and cannot be fully queried by apps.")
            }

            Section("Personal Data") {
                ForEach(OffloadPermissionManager.allCommands.filter { $0.category == .privacy }, id: \.name) { capability in
                    NavigationLink {
                        NativeCapabilityDetailView(capability: capability, state: probe.state(for: capability.name))
                    } label: {
                        NativeCapabilityRow(
                            title: capability.displayLabel,
                            subtitle: capability.description,
                            systemImage: capability.systemImage,
                            state: probe.state(for: capability.name)
                        )
                    }
                }
            }

            Section("Media & Device") {
                ForEach(OffloadPermissionManager.allCommands.filter { $0.category != .privacy }, id: \.name) { capability in
                    NavigationLink {
                        NativeCapabilityDetailView(capability: capability, state: probe.state(for: capability.name))
                    } label: {
                        NativeCapabilityRow(
                            title: capability.displayLabel,
                            subtitle: capability.description.isEmpty ? capability.actions.first ?? "Native device capability" : capability.description,
                            systemImage: capability.systemImage,
                            state: probe.state(for: capability.name)
                        )
                    }
                }
            }

            Section("App Integrations") {
                ForEach(SupplementalCapability.all) { capability in
                    NavigationLink {
                        SupplementalCapabilityDetailView(capability: capability, state: probe.state(for: capability.id))
                    } label: {
                        NativeCapabilityRow(
                            title: capability.title,
                            subtitle: capability.summary,
                            systemImage: capability.systemImage,
                            state: probe.state(for: capability.id)
                        )
                    }
                }
            }

            Section {
                Text("通讯录已接入。后台定位与音频只用于已声明的体验，不保证任意任务能一直在后台跑。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } header: {
                Text("已知边界")
            }
        }
        .navigationTitle("Apple Capabilities")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await probe.refresh() }
        .task { await probe.refresh() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if probe.isRefreshing {
                    ProgressView()
                } else {
                    Button {
                        Task { await probe.refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh capability status")
                }
            }
        }
    }
}

private struct NativeCapabilityRow: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let state: CapabilityAuthorizationState

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.body.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            Image(systemName: state.systemImage)
                .foregroundStyle(state.tint)
                .accessibilityLabel(state.title)
        }
    }
}

private struct NativeCapabilityDetailView: View {
    let capability: OffloadCommandInfo
    let state: CapabilityAuthorizationState
    @ObservedObject private var manager = OffloadPermissionManager.shared
    @State private var level: OffloadPermissionLevel

    init(capability: OffloadCommandInfo, state: CapabilityAuthorizationState) {
        self.capability = capability
        self.state = state
        _level = State(initialValue: OffloadPermissionManager.shared.permissionLevel(for: capability.name))
    }

    var body: some View {
        List {
            Section {
                LabeledContent("System Access") {
                    Label(state.title, systemImage: state.systemImage)
                        .foregroundStyle(state.tint)
                }
                Picker("Agent Access", selection: $level) {
                    ForEach(OffloadPermissionLevel.allCases, id: \.self) { item in
                        Text(item.displayName).tag(item)
                    }
                }
                .onChange(of: level) { manager.setPermissionLevel($0, for: capability.name) }
            } footer: {
                Text("Agent Access applies to direct native tool calls. Shell wrappers or chained commands may not be identified by the preflight gate; native iOS permission remains authoritative.")
            }

            Section("Available Actions") {
                ForEach(capability.actions, id: \.self) { action in
                    Label(action, systemImage: "checkmark")
                }
            }

            Section("Example") {
                Text(capability.examplePrompt)
                    .textSelection(.enabled)
            }

            Section("Data Destination") {
                Text(capability.dataDestination)
            }
        }
        .navigationTitle(capability.displayLabel)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct SupplementalCapabilityDetailView: View {
    let capability: SupplementalCapability
    let state: CapabilityAuthorizationState

    var body: some View {
        List {
            Section {
                LabeledContent("System Access") {
                    Label(state.title, systemImage: state.systemImage)
                        .foregroundStyle(state.tint)
                }
                Text(capability.summary)
                    .foregroundStyle(.secondary)
            }
            Section("Available Actions") {
                ForEach(capability.actions, id: \.self) { action in
                    Label(action, systemImage: "checkmark")
                }
            }
            Section("Data Destination") {
                Text(capability.dataDestination)
            }
        }
        .navigationTitle(capability.title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct CommandPermissionRow: View {
    let command: OffloadCommandInfo
    @ObservedObject private var manager = OffloadPermissionManager.shared

    @State private var level: OffloadPermissionLevel

    init(command: OffloadCommandInfo) {
        self.command = command
        _level = State(initialValue: OffloadPermissionManager.shared.permissionLevel(for: command.name))
    }

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(command.displayLabel)
                Text(command.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Picker("", selection: $level) {
                ForEach(OffloadPermissionLevel.allCases, id: \.self) { lvl in
                    Text(lvl.displayName).tag(lvl)
                }
            }
            .pickerStyle(.menu)
            .onChange(of: level) { newValue in
                manager.setPermissionLevel(newValue, for: command.name)
            }
        }
    }
}
