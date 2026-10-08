import Foundation
import OSLog
import Security
import UIKit

/// Pure resolution table for the device id, with the Keychain injected so the
/// locked-before-first-unlock branch is testable.
///
/// After a reboot iOS can relaunch the app in the background BEFORE first
/// unlock (BGTask, CloudKit push). The item is `AfterFirstUnlockThisDeviceOnly`,
/// so the read answers `errSecInteractionNotAllowed`, not `errSecItemNotFound`.
/// The old `static let` treated both as "nothing stored", minted a new UUID,
/// overwrote the real one (write deletes first) and froze it for the whole
/// process: wrong `device-<id>` zone, duplicate SyncDevice, own records seen as
/// a peer's. Rules:
///   - found & non-blank → memoize.
///   - absent (or blank/undecodable) → mint, persist, memoize; remember the
///     previous id (UserDefaults) so sync can retire its ghost record.
///   - unreadable (any other status) → provisional id, NO write, NO memo.
///   - mint whose write fails → also provisional: an id that will not survive
///     relaunch must never tag data (it would be orphaned next launch).
final class DeviceIdentityResolver: @unchecked Sendable {
    enum KeychainRead: Equatable {
        case found(String)
        /// Confirmed absent (`errSecItemNotFound`) or present but undecodable.
        case absent
        /// The Keychain refused to answer; never evidence of absence.
        case unreadable(OSStatus)
    }

    static let previousIdKey = "deviceIdentity.previousId"
    static let retiredIdKey = "deviceIdentity.retiredId"
    static let provisionalPrefix = "provisional-"

    private let read: () -> KeychainRead
    private let write: (String) -> Bool
    private let defaults: UserDefaults
    private let mint: () -> String
    private let lock = NSLock()
    private var cached: String?
    /// Stable within the process so repeated locked reads agree; never stored.
    let provisionalId: String

    init(read: @escaping () -> KeychainRead,
         write: @escaping (String) -> Bool,
         defaults: UserDefaults = .standard,
         mint: @escaping () -> String = { UUID().uuidString }) {
        self.read = read
        self.write = write
        self.defaults = defaults
        self.mint = mint
        self.provisionalId = Self.provisionalPrefix + UUID().uuidString
    }

    var deviceId: String {
        lock.lock(); defer { lock.unlock() }
        if let cached { return cached }
        switch read() {
        case .found(let raw):
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty {
                cached = trimmed
                defaults.set(trimmed, forKey: Self.previousIdKey)
                return trimmed
            }
            return mintLocked()
        case .absent:
            return mintLocked()
        case .unreadable:
            return provisionalId
        }
    }

    private func mintLocked() -> String {
        let newId = mint()
        guard write(newId) else { return provisionalId }
        cached = newId
        if let prev = defaults.string(forKey: Self.previousIdKey), prev != newId,
           !prev.hasPrefix(Self.provisionalPrefix), !prev.isEmpty {
            defaults.set(prev, forKey: Self.retiredIdKey)
        }
        defaults.set(newId, forKey: Self.previousIdKey)
        return newId
    }

    /// Resolves first: an empty cache before the first read is not provisional.
    var isProvisional: Bool {
        _ = deviceId
        lock.lock(); defer { lock.unlock() }
        return cached == nil
    }

    /// An id replaced by a fresh mint whose cloud device record should be
    /// retired. Consumed once.
    func takeRetiredDeviceId() -> String? {
        lock.lock(); defer { lock.unlock() }
        let v = defaults.string(forKey: Self.retiredIdKey)
        if v != nil { defaults.removeObject(forKey: Self.retiredIdKey) }
        return v
    }
}

/// Stable device identity persisted in Keychain (survives app reinstall).
/// Used for per-device CKRecordZone naming in iCloud sync.
enum DeviceIdentity {
    private static let keychainService = "com.leoyuan.leophoneagent.device"
    private static let keychainAccount = "deviceId"

    private static let resolver = DeviceIdentityResolver(read: readKeychain, write: writeKeychain)

    /// Stable UUID for this device, persisted in Keychain. While the Keychain
    /// is locked (before first unlock) this is a `provisional-` id that is
    /// never persisted; sync and provenance must check `isProvisional`.
    static var deviceId: String { resolver.deviceId }

    /// True when `deviceId` is answering with a throwaway id because the
    /// Keychain cannot be read yet. Nothing may be written under it.
    static var isProvisional: Bool { resolver.isProvisional }

    static func isProvisional(_ id: String) -> Bool {
        id.hasPrefix(DeviceIdentityResolver.provisionalPrefix)
    }

    /// Previous id to retire after a re-mint (restore to a new device, lost
    /// Keychain item). Consumed once by SyncV2Bootstrap.
    static func takeRetiredDeviceId() -> String? { resolver.takeRetiredDeviceId() }

    /// Human-readable device name with short ID suffix for disambiguation.
    /// Prefers user-set name (e.g. "Ethan's iPhone") if available (iOS returns it when
    /// the privacy entitlement is present). Falls back to hardware model (e.g. "iPhone 16 Pro").
    /// Always appends a 4-char ID suffix (e.g. "· A3F2").
    static var deviceName: String {
        let shortId = String(deviceId.suffix(4)).uppercased()
        let userName = UIDevice.current.name
        let genericNames: Set<String> = ["iPhone", "iPad", "iPod touch", "Mac", "Apple Watch"]
        // If UIDevice returns a personalized name, use it
        if !genericNames.contains(userName) {
            return "\(userName) · \(shortId)"
        }
        // Otherwise use hardware model
        return "\(modelName) · \(shortId)"
    }

    /// Hardware model name (e.g. "iPhone 16 Pro", "iPad Pro 13\" (M4)", "MacBook Pro").
    static var modelName: String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machine = withUnsafePointer(to: &systemInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) {
                String(validatingUTF8: $0) ?? "Unknown"
            }
        }
        return modelNameMap(for: machine)
    }

    private static func modelNameMap(for identifier: String) -> String {
        let map: [String: String] = [
            // iPhone 17 (2025) & iPhone 17e (2026)
            "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max",
            "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone Air",
            "iPhone18,5": "iPhone 17e",
            // iPhone 16 (2024)
            "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max",
            "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus",
            "iPhone17,5": "iPhone 16e",
            // iPhone 15 (2023)
            "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
            "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
            // iPhone 14 (2022)
            "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max",
            "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
            // iPhone 13 (2021)
            "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
            "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13",
            // iPhone SE
            "iPhone12,8": "iPhone SE (2nd generation)",
            "iPhone14,6": "iPhone SE (3rd generation)",
            // iPad Pro M4 (2024)
            "iPad16,3": "iPad Pro 11\" (M4)", "iPad16,4": "iPad Pro 11\" (M4)",
            "iPad16,5": "iPad Pro 13\" (M4)", "iPad16,6": "iPad Pro 13\" (M4)",
            // iPad Pro M2 (2022)
            "iPad14,3": "iPad Pro 11\" (M2)", "iPad14,4": "iPad Pro 11\" (M2)",
            "iPad14,5": "iPad Pro 12.9\" (M2)", "iPad14,6": "iPad Pro 12.9\" (M2)",
            // iPad Pro M1 (2021)
            "iPad13,4": "iPad Pro 11\" (M1)", "iPad13,5": "iPad Pro 11\" (M1)",
            "iPad13,6": "iPad Pro 11\" (M1)", "iPad13,7": "iPad Pro 11\" (M1)",
            "iPad13,8": "iPad Pro 12.9\" (M1)", "iPad13,9": "iPad Pro 12.9\" (M1)",
            "iPad13,10": "iPad Pro 12.9\" (M1)", "iPad13,11": "iPad Pro 12.9\" (M1)",
            // iPad Air M3 (2025)
            "iPad15,3": "iPad Air 11\" (M3)", "iPad15,4": "iPad Air 11\" (M3)",
            "iPad15,5": "iPad Air 13\" (M3)", "iPad15,6": "iPad Air 13\" (M3)",
            // iPad Air M2 (2024)
            "iPad14,8": "iPad Air 11\" (M2)", "iPad14,9": "iPad Air 11\" (M2)",
            "iPad14,10": "iPad Air 13\" (M2)", "iPad14,11": "iPad Air 13\" (M2)",
            // iPad Air M1 (2022)
            "iPad13,16": "iPad Air (M1)", "iPad13,17": "iPad Air (M1)",
            // iPad mini
            "iPad14,1": "iPad mini (6th generation)",
            "iPad14,2": "iPad mini (6th generation)",
            "iPad16,1": "iPad mini (A17 Pro)", "iPad16,2": "iPad mini (A17 Pro)",
            // iPad (10th generation, 2022)
            "iPad13,18": "iPad (10th generation)",
            "iPad13,19": "iPad (10th generation)",
            // iPad (11th generation, 2025)
            "iPad15,7": "iPad (11th generation)",
            "iPad15,8": "iPad (11th generation)",
            // Mac (Catalyst) — uname returns "arm64" or "x86_64"
            "arm64": "Mac", "x86_64": "Mac",
        ]
        if let name = map[identifier] { return name }
        if identifier.hasPrefix("iPhone") { return "iPhone" }
        if identifier.hasPrefix("iPad") { return "iPad" }
        // Catalyst/Mac fallback: try to get Mac model from sysctl
        #if targetEnvironment(macCatalyst)
        return macModelName() ?? "Mac"
        #else
        return UIDevice.current.model
        #endif
    }

    #if targetEnvironment(macCatalyst)
    private static func macModelName() -> String? {
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        guard size > 0 else { return nil }
        var model = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.model", &model, &size, nil, 0)
        let hwModel = String(cString: model) // e.g. "Mac14,6"
        let macMap: [String: String] = [
            "Mac14,6": "MacBook Pro 16\" (M2 Pro)",
            "Mac14,10": "MacBook Pro 16\" (M2 Max)",
            "Mac14,5": "MacBook Pro 14\" (M2 Pro)",
            "Mac14,9": "MacBook Pro 14\" (M2 Max)",
            "Mac15,3": "MacBook Pro 14\" (M3)",
            "Mac15,6": "MacBook Pro 14\" (M3 Pro)",
            "Mac15,7": "MacBook Pro 14\" (M3 Pro)",
            "Mac15,8": "MacBook Pro 14\" (M3 Max)",
            "Mac15,9": "MacBook Pro 16\" (M3 Pro)",
            "Mac15,10": "MacBook Pro 16\" (M3 Pro)",
            "Mac15,11": "MacBook Pro 16\" (M3 Max)",
            "Mac16,1": "MacBook Pro 14\" (M4)",
            "Mac16,5": "MacBook Pro 14\" (M4 Pro)",
            "Mac16,6": "MacBook Pro 14\" (M4 Pro)",
            "Mac16,7": "MacBook Pro 16\" (M4 Pro)",
            "Mac16,8": "MacBook Pro 14\" (M4 Max)",
            "Mac16,10": "MacBook Pro 16\" (M4 Max)",
            "Mac15,12": "MacBook Air 13\" (M3)",
            "Mac15,13": "MacBook Air 15\" (M3)",
            "Mac16,12": "MacBook Air 13\" (M4)",
            "Mac16,13": "MacBook Air 15\" (M4)",
            "Mac14,2": "MacBook Air 13\" (M2)",
            "Mac14,15": "MacBook Air 15\" (M2)",
            "Mac15,4": "iMac 24\" (M3)",
            "Mac15,5": "iMac 24\" (M3)",
            "Mac16,2": "iMac 24\" (M4)",
            "Mac16,3": "Mac mini (M4)",
            "Mac16,4": "Mac mini (M4 Pro)",
            "Mac14,12": "Mac mini (M2)",
            "Mac14,13": "Mac mini (M2 Pro)",
            "Mac14,14": "Mac Pro (M2 Ultra)",
            "Mac14,8": "Mac Studio (M2 Max)",
        ]
        return macMap[hwModel] ?? (hwModel.hasPrefix("Mac") ? "Mac" : nil)
    }
    #endif

    /// CKRecordZone name for this device.
    static var zoneName: String {
        "device-\(deviceId)"
    }

    /// OS version string (e.g. "18.3.2").
    static var osVersion: String {
        UIDevice.current.systemVersion
    }

    // MARK: - Keychain Helpers

    private static func readKeychain() -> DeviceIdentityResolver.KeychainRead {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let s = String(data: data, encoding: .utf8) else { return .absent }
            return .found(s)
        case errSecItemNotFound:
            return .absent
        default:
            // errSecInteractionNotAllowed (-25308) is the locked-after-reboot
            // case; any other status gets the same conservative treatment.
            identityLog.error("deviceId keychain unreadable status=\(status, privacy: .public); using provisional id, nothing written")
            return .unreadable(status)
        }
    }

    private static func writeKeychain(_ value: String) -> Bool {
        let match: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        // Only reached when the item is absent or blank, so replacing it is safe.
        SecItemDelete(match as CFDictionary)
        var add = match
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status != errSecSuccess {
            identityLog.error("deviceId persist failed status=\(status, privacy: .public); staying provisional")
            return false
        }
        return true
    }
}

private let identityLog = Logger(subsystem: "com.leoyuan.leophoneagent", category: "DeviceIdentity")
