//
//  CapabilityAuthorizationProbe.swift
//  MinisApp
//
//  [T-capabilities-center] Reads the CURRENT system authorization for each
//  native capability without asking for it.
//
//  Every offload handler in NativeOffloads/ requests permission inline, using
//  a semaphore to make the async callback synchronous for the guest thread.
//  That is fine when the agent is actually invoking a tool, but it means the
//  only way to learn "does Calendar have access?" was to trigger a permission
//  prompt. A settings screen obviously cannot do that.
//
//  So this deliberately calls only the *status* APIs — never a `request`. It
//  also does not touch iSH at all, which is what lets the Capabilities screen
//  show real state on a cold app with the kernel un-booted.
//

import AVFoundation
import Contacts
import CoreBluetooth
import CoreLocation
import CoreMotion
import EventKit
import Foundation
import HealthKit
import MediaPlayer
import Photos
import Speech
import UserNotifications

@MainActor
final class CapabilityAuthorizationProbe: ObservableObject {
    static let shared = CapabilityAuthorizationProbe()

    enum Status: Equatable {
        case authorized
        case limited(String)
        case denied
        case notDetermined
        /// The platform exposes no way to read this without prompting.
        case unknown(String)
        case unavailable(String)

        var label: String {
            switch self {
            case .authorized: return String(localized: "Authorized")
            case .limited(let detail): return detail
            case .denied: return String(localized: "Denied")
            case .notDetermined: return String(localized: "Not asked")
            case .unknown: return String(localized: "Cannot query")
            case .unavailable: return String(localized: "Unavailable")
            }
        }

        var isProblem: Bool {
            if case .denied = self { return true }
            if case .unavailable = self { return true }
            return false
        }

        var symbolName: String {
            switch self {
            case .authorized: return "checkmark.circle.fill"
            case .limited: return "checkmark.circle"
            case .denied: return "xmark.circle.fill"
            case .notDetermined: return "questionmark.circle"
            case .unknown: return "minus.circle"
            case .unavailable: return "exclamationmark.triangle.fill"
            }
        }
    }

    @Published private(set) var statuses: [String: Status] = [:]

    private let healthStore = HKHealthStore()
    /// Reused across probes: allocating a CLLocationManager per read just to
    /// look at `authorizationStatus` spins up the whole object each time.
    private let locationManager = CLLocationManager()

    /// Re-reads every capability. Cheap: all of these are synchronous
    /// property reads except notifications, which is a callback.
    func refresh() {
        var next: [String: Status] = [:]

        next["apple-calendar"] = Self.eventKit(.event)
        next["apple-reminders"] = Self.eventKit(.reminder)
        next["apple-photos"] = Self.photos()
        next["apple-location"] = location()
        next["apple-speech"] = Self.speech()
        next["apple-media"] = Self.mediaLibrary()
        next["apple-player"] = next["apple-media"]
        next["apple-bluetooth"] = Self.bluetooth()
        next["apple-healthkit"] = healthKit()
        next["apple-nfc"] = Self.nfc()
        next["apple-contacts"] = Self.contacts()
        next["apple-camera"] = Self.camera()
        next["apple-motion"] = Self.motion()
        // No status API exists for these; say so rather than implying "off".
        next["apple-homekit"] = .unknown(String(localized: "HomeKit exposes no status API; asked on first use"))
        next["apple-clipboard"] = .unknown(String(localized: "iOS asks on demand when reading"))
        next["apple-alarm"] = .unknown(String(localized: "Asked on first use"))
        next["apple-files"] = .unknown(String(localized: "Per-folder grants via the system picker"))
        next["apple-shortcuts"] = .unknown(String(localized: "Runs through the Shortcuts app"))

        // [T-capability-probe-flicker] Carry the async-filled notification row
        // across. `refresh()` runs on every onAppear (list AND every detail
        // push), and replacing the whole dictionary blanked this one key until
        // the callback returned a runloop later — so the row's status glyph
        // blinked out and back on every navigation, and the notification detail
        // screen showed "—" on entry.
        if let existing = statuses["apple-notification"] {
            next["apple-notification"] = existing
        }
        statuses = next

        // Notifications are async; fold it in when it lands.
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status: Status
            switch settings.authorizationStatus {
            case .authorized, .provisional: status = .authorized
            case .ephemeral: status = .limited(String(localized: "Temporary"))
            case .denied: status = .denied
            case .notDetermined: status = .notDetermined
            @unknown default: status = .unknown(String(localized: "Unknown state"))
            }
            Task { @MainActor in
                self.statuses["apple-notification"] = status
            }
        }
    }

    // MARK: - Per-framework probes (status only — never `request`)

    private static func contacts() -> Status {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: return .authorized
        case .limited: return .limited(String(localized: "Selected contacts only"))
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown(String(localized: "Unknown state"))
        }
    }

    private static func camera() -> Status {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .authorized
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown(String(localized: "Unknown state"))
        }
    }

    private static func motion() -> Status {
        switch CMPedometer.authorizationStatus() {
        case .authorized: return .authorized
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown(String(localized: "Unknown state"))
        }
    }

    private static func eventKit(_ type: EKEntityType) -> Status {
        switch EKEventStore.authorizationStatus(for: type) {
        case .fullAccess: return .authorized
        case .writeOnly: return .limited(String(localized: "Write only"))
        case .authorized: return .authorized
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown(String(localized: "Unknown state"))
        }
    }

    private static func photos() -> Status {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized: return .authorized
        case .limited: return .limited(String(localized: "Selected photos only"))
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown(String(localized: "Unknown state"))
        }
    }

    private func location() -> Status {
        switch locationManager.authorizationStatus {
        case .authorizedAlways: return .authorized
        case .authorizedWhenInUse: return .limited(String(localized: "While in use"))
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown(String(localized: "Unknown state"))
        }
    }

    private static func speech() -> Status {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return .authorized
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown(String(localized: "Unknown state"))
        }
    }

    private static func mediaLibrary() -> Status {
        switch MPMediaLibrary.authorizationStatus() {
        case .authorized: return .authorized
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown(String(localized: "Unknown state"))
        }
    }

    private static func bluetooth() -> Status {
        switch CBManager.authorization {
        case .allowedAlways: return .authorized
        case .denied, .restricted: return .denied
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown(String(localized: "Unknown state"))
        }
    }

    /// HealthKit only reports SHARE (write) authorization; read access is
    /// deliberately unreadable by design so an app cannot infer what the user
    /// declined. Say that plainly instead of showing a misleading value.
    private func healthKit() -> Status {
        guard HKHealthStore.isHealthDataAvailable() else {
            return .unavailable(String(localized: "Health data is not supported on this device"))
        }
        guard let steps = HKObjectType.quantityType(forIdentifier: .stepCount) else {
            return .unknown(String(localized: "Cannot resolve health data type"))
        }
        switch healthStore.authorizationStatus(for: steps) {
        case .sharingAuthorized: return .limited(String(localized: "Writable; iOS does not allow querying read access"))
        case .sharingDenied: return .limited(String(localized: "Write denied; iOS does not allow querying read access"))
        case .notDetermined: return .notDetermined
        @unknown default: return .unknown(String(localized: "Unknown state"))
        }
    }

    private static func nfc() -> Status {
        // NFCNDEFReaderSession.readingAvailable is a capability check, not an
        // authorization one — NFC has no user-facing permission.
        #if canImport(CoreNFC)
        if #available(iOS 13.0, *) {
            return NFCAvailability.isAvailable
                ? .limited(String(localized: "Hardware available; authorized per use"))
                : .unavailable(String(localized: "This device does not support NFC"))
        }
        #endif
        return .unavailable(String(localized: "This device does not support NFC"))
    }
}

#if canImport(CoreNFC)
import CoreNFC

private enum NFCAvailability {
    static var isAvailable: Bool { NFCNDEFReaderSession.readingAvailable }
}
#endif
