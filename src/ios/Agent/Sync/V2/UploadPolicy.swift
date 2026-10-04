import Foundation

/// Per-device user preference: which v2 record types this device is
/// allowed to push to iCloud, and the per-file size cap on SessionFile
/// asset content.
///
/// Settings live in UserDefaults so they survive launches and can be
/// flipped from the Settings sheet without restarting the engine.
/// Defaults are permissive — fresh installs sync everything until the
/// user opts out.
///
/// Local edits/deletes remain in the dirty queue while a category is off.
/// Filtering happens before dequeue limits and again at each network send.
/// Records already uploaded are not removed by turning a category off.
enum UploadPolicy {

    enum Category: String, CaseIterable {
        case chatSessions          // Session, Message, CompactMarker
        case sessionFiles          // SessionFile (binary attachments)
        case artifacts             // Artifact metadata + immutable versions
        case skills                // Skill (and SkillFile if any)
        case providers             // ProviderConfig
        case envVars               // EnvVar
        case memory                // MemoryGlobalV2 + MemoryDailyV2

        /// SQLite record_type values that fall under this category.
        var recordTypes: Set<String> {
            switch self {
            case .chatSessions:
                return ["Session", "SessionV2", "Message", "MessageV2", "CompactMarker", "CompactMarkerV2"]
            case .sessionFiles:
                return ["SessionFile", "SessionFileV2"]
            case .artifacts:
                return ["ArtifactV2", "ArtifactVersionV2"]
            case .skills:
                return ["Skill", "SkillV2"]
            case .providers:
                return ["ProviderConfig", "ProviderConfigV2", "ProviderInstanceV3", "ProviderModelEntryV3", "ProviderModelGroupV3"]
            case .envVars:
                return ["EnvVar", "EnvVarV2", "EnvVarItem"]
            case .memory:
                return ["Soul", "SoulV2", "MemoryGlobalV2", "MemoryDailyV2"]
            }
        }

        var defaultsKey: String { "cloudSync.v2.upload.\(rawValue)" }

        /// Display name for the Settings UI.
        var displayName: String {
            switch self {
            case .chatSessions: return "Chat Sessions"
            case .sessionFiles: return "Session Files"
            case .artifacts:    return "Artifacts"
            case .skills:       return "Skills"
            case .providers:    return "Providers"
            case .envVars:      return "Environments"
            case .memory:       return "Memory Files"
            }
        }
    }

    /// Read whether the user has opted IN to syncing a category.
    /// Defaults to true on first read (permissive).
    static func isEnabled(_ cat: Category) -> Bool {
        if UserDefaults.standard.object(forKey: cat.defaultsKey) == nil {
            let initialValue = cat != .artifacts
            UserDefaults.standard.set(initialValue, forKey: cat.defaultsKey)
            return initialValue
        }
        return UserDefaults.standard.bool(forKey: cat.defaultsKey)
    }

    static func setEnabled(_ cat: Category, _ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: cat.defaultsKey)
    }

    /// Quick lookup: may this record leave the device right now?
    /// SyncDeviceV2 is always allowed (device discovery itself can't be
    /// disabled — without it the device list would never populate).
    static func allowsRecordType(_ recordType: String) -> Bool {
        if recordType == "SyncDevice" || recordType == "SyncDeviceV2" {
            return true
        }
        for cat in Category.allCases where cat.recordTypes.contains(recordType) {
            return isEnabled(cat)
        }
        return true   // unknown types pass through (forward-compat)
    }

    static var disabledRecordTypes: Set<String> {
        Set(Category.allCases.filter { !isEnabled($0) }.flatMap { $0.recordTypes })
    }

    /// The legacy fallback engine must respect both its persisted preferences
    /// and the current category controls, including batches queued before a toggle.
    static func allowsLegacyRecordType(_ recordType: String) -> Bool {
        guard allowsRecordType(recordType) else { return false }
        let key: String
        switch recordType {
        case "Session", "Message", "CompactMarker": key = "cloudSync.syncSessions"
        case "SessionFile": key = "cloudSync.syncFiles"
        case "Skill": key = "cloudSync.syncSkills"
        case "ProviderConfig": key = "cloudSync.syncProviders"
        case "EnvVar": key = "cloudSync.syncEnvironments"
        case "SyncDevice": return true
        default: return false
        }
        return (UserDefaults.standard.object(forKey: key) as? Bool) ?? true
    }

    static func allowsRecordName(_ name: String, legacy: Bool = false) -> Bool {
        guard let separator = name.firstIndex(of: ":"), separator != name.startIndex else { return false }
        let type = String(name[..<separator])
        return legacy ? allowsLegacyRecordType(type) : allowsRecordType(type)
    }

    struct UploadPaused: Error {}

    static func requireUpload(_ recordType: String) throws {
        guard allowsRecordType(recordType) else { throw UploadPaused() }
    }

    // MARK: - Per-file cap

    /// Max per-file size in bytes that this device is willing to push
    /// for SessionFile asset content. Files above the cap are skipped
    /// at markDirty time. UserDefaults default = 1 MB.
    static let maxFileSizeKey = "cloudSync.v2.upload.maxFileSize"
    static var maxFileSizeBytes: Int {
        get {
            let v = UserDefaults.standard.integer(forKey: maxFileSizeKey)
            return v > 0 ? v : (1 * 1024 * 1024)
        }
        set { UserDefaults.standard.set(newValue, forKey: maxFileSizeKey) }
    }

    static let maxArtifactSizeKey = "cloudSync.v2.upload.maxArtifactSize"
    static var maxArtifactSizeBytes: Int {
        get {
            let value = UserDefaults.standard.integer(forKey: maxArtifactSizeKey)
            return value > 0 ? value : (25 * 1_024 * 1_024)
        }
        set { UserDefaults.standard.set(newValue, forKey: maxArtifactSizeKey) }
    }

    /// Comma-joined string of category record-types currently enabled,
    /// used in SyncedDevice.uploadTypes so peers can see what we sync.
    static func currentUploadTypesString() -> String {
        Category.allCases
            .filter { isEnabled($0) }
            .map { $0.rawValue }
            .joined(separator: ",")
    }

    // MARK: - Custom device name

    static let deviceNameKey = "cloudSync.v2.deviceName"
    static var customDeviceName: String? {
        get { UserDefaults.standard.string(forKey: deviceNameKey) }
        set {
            if let s = newValue, !s.isEmpty {
                UserDefaults.standard.set(s, forKey: deviceNameKey)
            } else {
                UserDefaults.standard.removeObject(forKey: deviceNameKey)
            }
        }
    }
}
