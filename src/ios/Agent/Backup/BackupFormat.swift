import Foundation

/// On-the-wire types for the `.minisbak` backup package (format `minisbak/1`).
///
/// Ported from upstream OpenMinis 1.14 and kept wire-compatible with the
/// Android fork: STORED zip, plaintext `manifest.json` with snake_case keys,
/// `data/*.jsonl` shards of `{t, v, d}` envelopes, content-addressed blobs.
///
/// Tolerance rules (upstream design §2.2):
///   1. An unknown MAJOR format is refused; same-major minor bumps import.
///   2. Unknown fields are ignored, missing fields get defaults — every
///      decoder here is hand-written because Swift's synthesized Decodable
///      throws `keyNotFound` even for properties that have a default.
///   3. One bad JSONL line is skipped, never fatal.
///
/// This file and the rest of the backup core compile into the app AND the
/// MinisTests logic bundle, so it must not reference app-only types
/// (ChatStore, ProviderConfigStore, AIChatViewModel …). The live stores are
/// reached through `BackupExportSource` / `BackupRestoreTarget`.
enum BackupFormat {
    /// Format major version. Kept at `minisbak/1` for interop with Android.
    static let current = "minisbak/1"
    static let fileExtension = "minisbak"
    /// Registered in Info.plist (`UTExportedTypeDeclarations`).
    static let contentTypeIdentifier = "com.leoyuan.leophoneagent.minisbak"
    /// Cap for a single JSONL shard; the writer rolls over beyond it.
    static let maxShardBytes = 64 * 1024 * 1024
    /// Directory (a sibling of `shared/`, NOT inside it) where finished
    /// packages are delivered. Also excluded defensively from file-tree export
    /// so a package can never be swept into the next backup.
    static let backupsDirectoryName = "Backups"

    /// Import-side safety limits (zip-bomb / resource-exhaustion guards).
    enum Limits {
        /// More entries than any real package (a 23k-session device produced
        /// ~25k members upstream).
        static let maxEntries = 400_000
        /// Hard ceiling on the sum of declared uncompressed sizes.
        static let maxTotalUncompressedBytes: Int64 = 64 * 1024 * 1024 * 1024
        /// Deflated members only exist in legacy packages and are always small
        /// metadata; anything larger is treated as hostile.
        static let maxDeflatedEntryBytes: Int64 = 32 * 1024 * 1024   // legacy deflate members are small metadata; whole-buffer inflate must not jetsam the phone
        /// A JSONL/JSON member we read into memory. Shards are ≤ 64 MB by format.
        static let maxDataFileBytes: Int64 = 96 * 1024 * 1024
        static let maxEntryNameBytes = 1024
        /// Manifest is tiny; refuse to buffer anything bigger before extraction.
        static let maxManifestBytes = 8 * 1024 * 1024
        /// A restored skill is rebuilt in memory (SkillStore's zip path).
        static let maxSkillBytes: Int64 = 128 * 1024 * 1024
    }
}

// MARK: - Categories

/// User-facing backup categories. The raw value is the manifest key and the
/// on-disk directory name, so renaming one is a format change.
///
/// Sub-agents are deliberately absent: the sub-agent roster is being ported in
/// a parallel lane and there is no compile-time way to test for a type's
/// existence in Swift. Packages from upstream/Android that carry
/// `data/sub_agents.jsonl` restore everything else; that file is ignored.
enum BackupCategory: String, Codable, CaseIterable, Sendable {
    case chats
    case sharedFiles = "shared_files"
    case skills
    case memory
    case providers
    case mcpServers = "mcp_servers"
    /// Wire value kept so packages that contain it still decode; never written
    /// by this build and ignored on restore.
    case voiceCorrections = "voice_corrections"
    case environmentVariables = "environment_variables"

    /// Categories a NEW backup may include.
    static var backupable: [BackupCategory] {
        [.chats, .sharedFiles, .skills, .memory, .providers, .mcpServers, .environmentVariables]
    }

    /// Restore order: chats first (largest, fails fast), providers before
    /// environment variables (secrets land with providers).
    static let restoreOrder: [BackupCategory] = [
        .chats, .sharedFiles, .skills, .memory, .providers, .environmentVariables, .mcpServers,
    ]

    var carriesFileTree: Bool {
        switch self {
        case .chats, .sharedFiles, .skills: return true
        default: return false
        }
    }

    var displayName: String {
        switch self {
        case .chats: return String(localized: "对话")
        case .sharedFiles: return String(localized: "共享文件")
        case .skills: return String(localized: "技能")
        case .memory: return String(localized: "记忆")
        case .providers: return String(localized: "服务商与模型分组")
        case .mcpServers: return String(localized: "MCP 服务器")
        case .voiceCorrections: return String(localized: "语音纠错")
        case .environmentVariables: return String(localized: "环境变量")
        }
    }

    var systemImage: String {
        switch self {
        case .chats: return "bubble.left.and.bubble.right"
        case .sharedFiles: return "folder"
        case .skills: return "sparkles"
        case .memory: return "brain"
        case .providers: return "server.rack"
        case .mcpServers: return "puzzlepiece.extension"
        case .voiceCorrections: return "waveform"
        case .environmentVariables: return "terminal"
        }
    }
}

// MARK: - Manifest

/// `manifest.json` — ALWAYS plaintext, so a package can be previewed before a
/// passphrase is asked for. In an encrypted package `integrity` holds the
/// CIPHERTEXT hashes, so completeness is checkable without the key.
struct BackupManifest: Codable, Sendable {
    var format: String = BackupFormat.current
    var createdAt: Date
    var snapshotAt: Date?
    var app: AppInfo
    /// Display-only. Never the device id — restoring that would make two
    /// devices fight over one sync identity.
    var deviceName: String
    var backupId: String
    var categories: [String: CategoryStat]
    var limits: Limits
    var encryption: Encryption?
    var integrity: [String: String]
    var manifestMac: String?

    enum CodingKeys: String, CodingKey {
        case format
        case createdAt = "created_at"
        case snapshotAt = "snapshot_at"
        case app
        case deviceName = "device_name"
        case backupId = "backup_id"
        case categories, limits, encryption, integrity
        case manifestMac = "manifest_mac"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        format = try c.decodeIfPresent(String.self, forKey: .format) ?? BackupFormat.current
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date(timeIntervalSince1970: 0)
        snapshotAt = try c.decodeIfPresent(Date.self, forKey: .snapshotAt)
        app = try c.decodeIfPresent(AppInfo.self, forKey: .app)
            ?? AppInfo(platform: "unknown", version: "?", build: "?")
        deviceName = try c.decodeIfPresent(String.self, forKey: .deviceName) ?? "Unknown device"
        backupId = try c.decodeIfPresent(String.self, forKey: .backupId) ?? UUID().uuidString
        categories = try c.decodeIfPresent([String: CategoryStat].self, forKey: .categories) ?? [:]
        limits = try c.decodeIfPresent(Limits.self, forKey: .limits) ?? .unlimited
        encryption = try c.decodeIfPresent(Encryption.self, forKey: .encryption)
        integrity = try c.decodeIfPresent([String: String].self, forKey: .integrity) ?? [:]
        manifestMac = try c.decodeIfPresent(String.self, forKey: .manifestMac)
    }

    init(createdAt: Date, app: AppInfo, deviceName: String, backupId: String,
         categories: [String: CategoryStat], limits: Limits,
         encryption: Encryption?, integrity: [String: String], manifestMac: String?,
         snapshotAt: Date? = nil) {
        self.createdAt = createdAt
        self.snapshotAt = snapshotAt
        self.app = app
        self.deviceName = deviceName
        self.backupId = backupId
        self.categories = categories
        self.limits = limits
        self.encryption = encryption
        self.integrity = integrity
        self.manifestMac = manifestMac
    }

    /// Categories present in the package that this build understands.
    var knownCategories: [BackupCategory] {
        BackupCategory.restoreOrder.filter { categories[$0.rawValue] != nil }
    }

    struct AppInfo: Codable, Sendable {
        var platform: String
        var version: String
        var build: String

        init(platform: String, version: String, build: String) {
            self.platform = platform; self.version = version; self.build = build
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            platform = try c.decodeIfPresent(String.self, forKey: .platform) ?? "unknown"
            version = try c.decodeIfPresent(String.self, forKey: .version) ?? "?"
            build = try c.decodeIfPresent(String.self, forKey: .build) ?? "?"
        }
    }

    struct CategoryStat: Codable, Sendable, Equatable {
        var entries: Int
        var bytes: Int64
        var encrypted: Bool
        var messages: Int?
        var files: Int?
        /// Providers only: thinking rules counted separately from `entries`.
        var thinkingRules: Int?
        /// Providers only: false = credentials NOT in this package.
        var includesCredentials: Bool?

        enum CodingKeys: String, CodingKey {
            case entries, bytes, encrypted, messages, files
            case thinkingRules = "thinking_rules"
            case includesCredentials = "includes_credentials"
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            entries = try c.decodeIfPresent(Int.self, forKey: .entries) ?? 0
            bytes = try c.decodeIfPresent(Int64.self, forKey: .bytes) ?? 0
            encrypted = try c.decodeIfPresent(Bool.self, forKey: .encrypted) ?? false
            messages = try c.decodeIfPresent(Int.self, forKey: .messages)
            files = try c.decodeIfPresent(Int.self, forKey: .files)
            thinkingRules = try c.decodeIfPresent(Int.self, forKey: .thinkingRules)
            includesCredentials = try c.decodeIfPresent(Bool.self, forKey: .includesCredentials)
        }

        init(entries: Int, bytes: Int64, encrypted: Bool,
             messages: Int? = nil, files: Int? = nil, thinkingRules: Int? = nil,
             includesCredentials: Bool? = nil) {
            self.entries = entries
            self.bytes = bytes
            self.encrypted = encrypted
            self.messages = messages
            self.files = files
            self.thinkingRules = thinkingRules
            self.includesCredentials = includesCredentials
        }
    }

    struct Limits: Codable, Sendable {
        var maxFileBytes: Int64?
        var skippedFiles: Int
        var skippedBytes: Int64

        enum CodingKeys: String, CodingKey {
            case maxFileBytes = "max_file_bytes"
            case skippedFiles = "skipped_files"
            case skippedBytes = "skipped_bytes"
        }

        init(maxFileBytes: Int64?, skippedFiles: Int, skippedBytes: Int64) {
            self.maxFileBytes = maxFileBytes
            self.skippedFiles = skippedFiles
            self.skippedBytes = skippedBytes
        }
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            maxFileBytes = try c.decodeIfPresent(Int64.self, forKey: .maxFileBytes)
            skippedFiles = try c.decodeIfPresent(Int.self, forKey: .skippedFiles) ?? 0
            skippedBytes = try c.decodeIfPresent(Int64.self, forKey: .skippedBytes) ?? 0
        }

        static let unlimited = Limits(maxFileBytes: nil, skippedFiles: 0, skippedBytes: 0)
    }

    struct Encryption: Codable, Sendable {
        var scheme: String
        var kdf: KDF
        var verifier: String

        struct KDF: Codable, Sendable {
            var alg: String
            var mKib: Int?
            var t: Int?
            var p: Int?
            var iterations: Int?
            var salt: String

            enum CodingKeys: String, CodingKey {
                case alg, t, p, iterations, salt
                case mKib = "m_kib"
            }

            init(alg: String, mKib: Int?, t: Int?, p: Int?, iterations: Int?, salt: String) {
                self.alg = alg; self.mKib = mKib; self.t = t
                self.p = p; self.iterations = iterations; self.salt = salt
            }
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                // No safe default exists for these two: a wrong guess derives
                // the wrong key and surfaces as "wrong passphrase".
                alg = try c.decode(String.self, forKey: .alg)
                salt = try c.decode(String.self, forKey: .salt)
                mKib = try c.decodeIfPresent(Int.self, forKey: .mKib)
                t = try c.decodeIfPresent(Int.self, forKey: .t)
                p = try c.decodeIfPresent(Int.self, forKey: .p)
                iterations = try c.decodeIfPresent(Int.self, forKey: .iterations)
            }
        }
    }
}

// MARK: - File index

/// One line of `files.index.jsonl` — the directory-tree index.
struct BackupFileIndexEntry: Codable, Sendable, Equatable {
    /// Package-relative logical path, e.g. `chats/<sid>/offloads/out.zip`.
    var path: String
    var size: Int64
    /// nil for directories and tombstones.
    var sha256: String?
    var category: String
    /// Present only on tombstones: `size`, `not_downloaded`, `unreadable`.
    var skipped: String?
    var isDirectory: Bool?
    /// LeoBot addition: source mtime (epoch seconds). Lets a restore decide
    /// "local newer → keep" for files. Absent in upstream/Android packages,
    /// in which case an existing, different local file is always kept.
    var mtime: Double?

    init(path: String, size: Int64, sha256: String?, category: String,
         skipped: String?, isDirectory: Bool?, mtime: Double? = nil) {
        self.path = path; self.size = size; self.sha256 = sha256
        self.category = category; self.skipped = skipped
        self.isDirectory = isDirectory; self.mtime = mtime
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        size = try c.decodeIfPresent(Int64.self, forKey: .size) ?? 0
        sha256 = try c.decodeIfPresent(String.self, forKey: .sha256)
        category = try c.decodeIfPresent(String.self, forKey: .category) ?? ""
        skipped = try c.decodeIfPresent(String.self, forKey: .skipped)
        isDirectory = try c.decodeIfPresent(Bool.self, forKey: .isDirectory)
        mtime = try c.decodeIfPresent(Double.self, forKey: .mtime)
    }

    static func file(path: String, size: Int64, sha256: String, category: BackupCategory,
                     mtime: Double? = nil) -> Self {
        .init(path: path, size: size, sha256: sha256, category: category.rawValue,
              skipped: nil, isDirectory: nil, mtime: mtime)
    }

    /// Size cap excluded it: keep the path and size so the gap stays visible.
    static func sizeSkipped(path: String, size: Int64, category: BackupCategory) -> Self {
        .init(path: path, size: size, sha256: nil, category: category.rawValue,
              skipped: "size", isDirectory: nil)
    }

    /// An undownloaded iCloud/FileProvider placeholder. MUST be a tombstone:
    /// packaging the placeholder would store a 0-byte file and a restore would
    /// overwrite the user's real file with nothing.
    static func notDownloaded(path: String, size: Int64, category: BackupCategory) -> Self {
        .init(path: path, size: size, sha256: nil, category: category.rawValue,
              skipped: "not_downloaded", isDirectory: nil)
    }

    static func unreadable(path: String, size: Int64, category: BackupCategory) -> Self {
        .init(path: path, size: size, sha256: nil, category: category.rawValue,
              skipped: "unreadable", isDirectory: nil)
    }

    static func directory(path: String, category: BackupCategory) -> Self {
        .init(path: path, size: 0, sha256: nil, category: category.rawValue,
              skipped: nil, isDirectory: true)
    }
}

/// One line of `blobs.index.jsonl` — content-addressed payload map.
struct BackupBlobIndexEntry: Codable, Sendable {
    var sha256: String
    var size: Int64
    var path: String
    var sessionId: String?
    var mime: String?
}

// MARK: - JSONL records

/// Envelope for every `data/*.jsonl` line: `t` dispatches, `v` allows
/// per-record migration.
struct BackupRecordEnvelope<Payload: Codable>: Codable {
    var t: String
    var v: Int
    var d: Payload

    init(t: String, v: Int = 1, d: Payload) {
        self.t = t
        self.v = v
        self.d = d
    }
}

/// Opaque JSON, used for values the backup must carry without understanding
/// them (message parts, token usage). Keeps the backup core independent of
/// the chat model types and tolerant of part kinds a newer writer added.
enum BackupJSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([BackupJSONValue])
    case object([String: BackupJSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let i = try? c.decode(Int64.self) { self = .int(i); return }
        if let d = try? c.decode(Double.self) { self = .double(d); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([BackupJSONValue].self) { self = .array(a); return }
        self = .object(try c.decode([String: BackupJSONValue].self))
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .int(let i): try c.encode(i)
        case .double(let d): try c.encode(d)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    /// Compact JSON text (used to hand parts back to the store as a column value).
    func jsonString() -> String? {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        guard let data = try? e.encode(self) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func parse(_ text: String) -> BackupJSONValue? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(BackupJSONValue.self, from: data)
    }

    var objectValue: [String: BackupJSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }
}

/// `SessionV2` payload. Field names mirror the app's `ChatSession` synthesized
/// coding so upstream/Android packages decode.
struct BackupSessionRecord: Codable, Sendable, Equatable {
    struct Session: Codable, Sendable, Equatable {
        var id: String
        var title: String?
        var category: String?
        var modelId: String
        var createdAt: Date
        var updatedAt: Date
        var source: String?
        var pinnedAt: Date?

        init(id: String, title: String?, category: String?, modelId: String,
             createdAt: Date, updatedAt: Date, source: String? = nil, pinnedAt: Date? = nil) {
            self.id = id; self.title = title; self.category = category
            self.modelId = modelId; self.createdAt = createdAt; self.updatedAt = updatedAt
            self.source = source; self.pinnedAt = pinnedAt
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            title = try c.decodeIfPresent(String.self, forKey: .title)
            category = try c.decodeIfPresent(String.self, forKey: .category)
            modelId = try c.decodeIfPresent(String.self, forKey: .modelId) ?? "unknown"
            createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date(timeIntervalSince1970: 0)
            updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? createdAt
            source = try c.decodeIfPresent(String.self, forKey: .source)
            pinnedAt = try c.decodeIfPresent(Date.self, forKey: .pinnedAt)
        }
    }

    var session: Session
    var memoryEnabled: Bool
    var modelBinding: String?

    init(session: Session, memoryEnabled: Bool, modelBinding: String?) {
        self.session = session
        self.memoryEnabled = memoryEnabled
        self.modelBinding = modelBinding
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        session = try c.decode(Session.self, forKey: .session)
        memoryEnabled = try c.decodeIfPresent(Bool.self, forKey: .memoryEnabled) ?? true
        modelBinding = try c.decodeIfPresent(String.self, forKey: .modelBinding)
    }
}

/// `MessageV2` payload — the app's `RawMessage` wire shape plus `updatedAt`.
struct BackupMessageRecord: Codable, Sendable, Equatable {
    var id: String
    var sessionId: String
    var role: String
    /// `[ContentPart]` carried opaquely.
    var parts: BackupJSONValue
    var createdAt: Date
    var tokenUsage: BackupJSONValue?
    var reasoningContent: String?
    var streamInterruptCount: Int
    var sortOrder: Int
    var errorInfo: String?
    /// LeoBot addition (absent upstream): the row's `updated_at`, for LWW.
    var updatedAt: Date?

    init(id: String, sessionId: String, role: String, parts: BackupJSONValue,
         createdAt: Date, tokenUsage: BackupJSONValue? = nil, reasoningContent: String? = nil,
         streamInterruptCount: Int = 0, sortOrder: Int, errorInfo: String? = nil,
         updatedAt: Date? = nil) {
        self.id = id; self.sessionId = sessionId; self.role = role; self.parts = parts
        self.createdAt = createdAt; self.tokenUsage = tokenUsage
        self.reasoningContent = reasoningContent; self.streamInterruptCount = streamInterruptCount
        self.sortOrder = sortOrder; self.errorInfo = errorInfo; self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        role = try c.decodeIfPresent(String.self, forKey: .role) ?? "user"
        parts = try c.decodeIfPresent(BackupJSONValue.self, forKey: .parts) ?? .array([])
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date(timeIntervalSince1970: 0)
        tokenUsage = try c.decodeIfPresent(BackupJSONValue.self, forKey: .tokenUsage)
        reasoningContent = try c.decodeIfPresent(String.self, forKey: .reasoningContent)
        streamInterruptCount = try c.decodeIfPresent(Int.self, forKey: .streamInterruptCount) ?? 0
        sortOrder = try c.decodeIfPresent(Int.self, forKey: .sortOrder) ?? 0
        errorInfo = try c.decodeIfPresent(String.self, forKey: .errorInfo)
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt)
    }

    var effectiveUpdatedAt: Date { updatedAt ?? createdAt }
}

/// `CompactMarkerV2` payload — the app's `CompactMarker` wire shape.
struct BackupCompactMarkerRecord: Codable, Sendable, Equatable {
    var id: String
    var sessionId: String
    var summary: String
    var firstKeptSortOrder: Int
    var compactedCount: Int
    var createdAt: Date
    var uiBoundarySortOrder: Int?
    var boundaryMessageId: String?
    var firstKeptMessageId: String?
    var lastCompactedMessageId: String?
    var version: Int

    init(id: String, sessionId: String, summary: String, firstKeptSortOrder: Int,
         compactedCount: Int, createdAt: Date, uiBoundarySortOrder: Int? = nil,
         boundaryMessageId: String? = nil, firstKeptMessageId: String? = nil,
         lastCompactedMessageId: String? = nil, version: Int = 1) {
        self.id = id; self.sessionId = sessionId; self.summary = summary
        self.firstKeptSortOrder = firstKeptSortOrder; self.compactedCount = compactedCount
        self.createdAt = createdAt; self.uiBoundarySortOrder = uiBoundarySortOrder
        self.boundaryMessageId = boundaryMessageId; self.firstKeptMessageId = firstKeptMessageId
        self.lastCompactedMessageId = lastCompactedMessageId; self.version = version
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        firstKeptSortOrder = try c.decodeIfPresent(Int.self, forKey: .firstKeptSortOrder) ?? 0
        compactedCount = try c.decodeIfPresent(Int.self, forKey: .compactedCount) ?? 0
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date(timeIntervalSince1970: 0)
        uiBoundarySortOrder = try c.decodeIfPresent(Int.self, forKey: .uiBoundarySortOrder)
        boundaryMessageId = try c.decodeIfPresent(String.self, forKey: .boundaryMessageId)
        firstKeptMessageId = try c.decodeIfPresent(String.self, forKey: .firstKeptMessageId)
        lastCompactedMessageId = try c.decodeIfPresent(String.self, forKey: .lastCompactedMessageId)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
    }
}

/// `SkillV2` payload (upstream shape). The skill's files, SKILL.md included,
/// travel as a file tree under `skills/<id>/`.
struct BackupSkillRecord: Codable, Sendable, Equatable {
    var id: String
    var name: String
    var description: String
    var version: String
    var isEnabled: Bool
    var installedAt: Date
    var updatedAt: Date
    var body: String
    var sourceURL: String?

    init(id: String, name: String, description: String, version: String, isEnabled: Bool,
         installedAt: Date, updatedAt: Date, body: String, sourceURL: String?) {
        self.id = id; self.name = name; self.description = description
        self.version = version; self.isEnabled = isEnabled; self.installedAt = installedAt
        self.updatedAt = updatedAt; self.body = body; self.sourceURL = sourceURL
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        version = try c.decodeIfPresent(String.self, forKey: .version) ?? "1.0.0"
        isEnabled = try c.decodeIfPresent(Bool.self, forKey: .isEnabled) ?? true
        installedAt = try c.decodeIfPresent(Date.self, forKey: .installedAt) ?? Date(timeIntervalSince1970: 0)
        updatedAt = try c.decodeIfPresent(Date.self, forKey: .updatedAt) ?? installedAt
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        sourceURL = try c.decodeIfPresent(String.self, forKey: .sourceURL)
    }
}

/// LeoBot's own thinking-ceiling rule (`ThinkingRuleStore`), carried in
/// `data/leo_thinking_rules.jsonl`. Upstream's `thinking_rules.jsonl` is a
/// different (per-instance wire-format) model and is ignored on restore.
struct BackupLeoThinkingRuleRecord: Codable, Sendable, Equatable {
    /// Model-id pattern; for ceiling rules a plain prefix (legacy shape).
    var prefix: String
    /// Ceiling level raw value, "" when the rule only rewrites the wire format.
    var maxLevel: String
    var defaultLevel: String
    /// Stable rule id (absent in packages written before rules carried one).
    var ruleId: String? = nil
    /// The full `ThinkingRule.persistedJSON` row, so wire-format and
    /// per-provider rules round-trip. Absent in older packages.
    var ruleJSON: String? = nil

    var id: String { ruleId ?? prefix.lowercased() }
}

/// `env_vars.json` row — metadata only, never the value.
struct BackupEnvVarRecord: Codable, Sendable, Equatable {
    var id: String
    var key: String
    var createdAt: Date
    var note: String

    init(id: String, key: String, createdAt: Date, note: String) {
        self.id = id; self.key = key; self.createdAt = createdAt; self.note = note
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        key = try c.decode(String.self, forKey: .key)
        createdAt = try c.decodeIfPresent(Date.self, forKey: .createdAt) ?? Date(timeIntervalSince1970: 0)
        note = try c.decodeIfPresent(String.self, forKey: .note) ?? ""
    }
}

/// `data/memory.meta.jsonl` line (LeoBot addition): a memory file's mtime so
/// restore can keep a locally newer file.
struct BackupMemoryMetaRecord: Codable, Sendable {
    var name: String
    var mtime: Double
}

// MARK: - Dates

enum BackupDates {
    /// Writer side: `.iso8601` (whole seconds) — the exact shape upstream and
    /// the Android fork read.
    static func encoder(pretty: Bool = false) -> JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = pretty ? [.sortedKeys, .withoutEscapingSlashes, .prettyPrinted]
                                    : [.sortedKeys, .withoutEscapingSlashes]
        e.dateEncodingStrategy = .iso8601
        return e
    }

    /// Reader side: ISO-8601 with or without fractional seconds, or a number
    /// (epoch seconds), so packages from any writer decode.
    static func decoder() -> JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let c = try decoder.singleValueContainer()
            if let n = try? c.decode(Double.self) {
                return Date(timeIntervalSince1970: n)
            }
            let s = try c.decode(String.self)
            if let date = parse(s) { return date }
            throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unrecognised date")
        }
        return d
    }

    /// ISO8601DateFormatter is documented thread-safe; building one per date
    /// would dominate decoding a 100k-message package.
    nonisolated(unsafe) private static let plainISO = ISO8601DateFormatter()
    nonisolated(unsafe) private static let fractionalISO: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func parse(_ s: String) -> Date? {
        plainISO.date(from: s) ?? fractionalISO.date(from: s)
    }
}

// MARK: - Errors

enum BackupError: LocalizedError {
    case stagingFailed(String)
    case writeFailed(String)
    case cancelled
    case busy(String)

    var errorDescription: String? {
        switch self {
        case .stagingFailed(let m): return String(localized: "备份准备失败：\(m)")
        case .writeFailed(let m): return String(localized: "备份写入失败：\(m)")
        case .cancelled: return String(localized: "已取消")
        case .busy(let m): return m
        }
    }
}
