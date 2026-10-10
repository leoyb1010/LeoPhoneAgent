import Foundation

/// [V-rec] 录音在磁盘上的唯一出入口。纯 Foundation,逻辑测试用临时根目录跑。
///
/// 布局:`<root>/<id>/meta.json · transcript.json · chunk-NNN.m4a · imported.<ext> · outputs/<outputId>.md`
/// - id 只接受 UUID,文件名只接受固定形状:外部传来的 id 不可能把路径带出录音根目录。
/// - 根目录、每条录音目录和其中每个文件都标 `isExcludedFromBackup`:音频不进 iCloud 云备份,
///   也不在 iCloud Drive(Library 下本来就不同步)。App 自己的备份包也跳过这里
///   (BackupFileTreeExporter.excludedRoots)。
/// - 删除录音 = 删除整个目录。
struct RecordingStore: Sendable {
    enum StoreError: Error, Equatable {
        case invalidId
        case invalidFileName
        case notFound
    }

    let root: URL

    init(root: URL) {
        self.root = root
    }

    /// `Library/MinisChat/recordings/`。
    static var defaultRoot: URL {
        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return library.appendingPathComponent("MinisChat", isDirectory: true)
            .appendingPathComponent("recordings", isDirectory: true)
    }

    static var shared: RecordingStore { RecordingStore(root: defaultRoot) }

    static let metadataFileName = "meta.json"
    static let transcriptFileName = "transcript.json"
    static let outputsDirectoryName = "outputs"

    // MARK: - Validation

    static func isValidId(_ id: String) -> Bool {
        id.utf8.count == 36 && UUID(uuidString: id) != nil
    }

    /// chunk-000.m4a … chunk-999.m4a,或导入的 imported.<ext>。
    static func isValidAudioFileName(_ name: String) -> Bool {
        if name.range(of: #"^chunk-[0-9]{3}\.m4a$"#, options: .regularExpression) != nil { return true }
        return name.range(of: #"^imported\.[a-z0-9]{1,8}$"#, options: .regularExpression) != nil
    }

    static func isValidOutputId(_ id: String) -> Bool { isValidId(id) }

    // MARK: - Paths

    func directory(for id: String) throws -> URL {
        guard Self.isValidId(id) else { throw StoreError.invalidId }
        return root.appendingPathComponent(id, isDirectory: true)
    }

    func metadataURL(for id: String) throws -> URL {
        try directory(for: id).appendingPathComponent(Self.metadataFileName)
    }

    func transcriptURL(for id: String) throws -> URL {
        try directory(for: id).appendingPathComponent(Self.transcriptFileName)
    }

    func audioURL(for id: String, fileName: String) throws -> URL {
        guard Self.isValidAudioFileName(fileName) else { throw StoreError.invalidFileName }
        return try directory(for: id).appendingPathComponent(fileName)
    }

    func outputURL(for id: String, outputId: String) throws -> URL {
        guard Self.isValidOutputId(outputId) else { throw StoreError.invalidId }
        return try directory(for: id)
            .appendingPathComponent(Self.outputsDirectoryName, isDirectory: true)
            .appendingPathComponent("\(outputId).md")
    }

    // MARK: - CRUD

    /// 建目录、写第一份 meta、打上不备份标记。
    func create(_ meta: RecordingMetadata) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let dir = try directory(for: meta.id)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try save(meta)
        applyBackupExclusion(id: meta.id)
    }

    func save(_ meta: RecordingMetadata) throws {
        let url = try metadataURL(for: meta.id)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try Self.encoder.encode(meta)
        try data.write(to: url, options: [.atomic])
        Self.excludeFromBackup(url)
    }

    func load(id: String) -> RecordingMetadata? {
        guard let url = try? metadataURL(for: id), let data = try? Data(contentsOf: url) else { return nil }
        guard let meta = try? Self.decoder.decode(RecordingMetadata.self, from: data), meta.id == id else { return nil }
        return meta
    }

    /// 全部录音,新的在前。目录名不是合法 id 的、meta 读不出来的跳过。
    func list() -> [RecordingMetadata] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: root.path) else { return [] }
        return names.filter(Self.isValidId).compactMap(load(id:)).sorted { $0.createdAt > $1.createdAt }
    }

    func saveTranscript(_ transcript: RecordingTranscript, id: String) throws {
        let url = try transcriptURL(for: id)
        let data = try Self.encoder.encode(transcript)
        try data.write(to: url, options: [.atomic])
        Self.excludeFromBackup(url)
    }

    func loadTranscript(id: String) -> RecordingTranscript? {
        guard let url = try? transcriptURL(for: id), let data = try? Data(contentsOf: url) else { return nil }
        return try? Self.decoder.decode(RecordingTranscript.self, from: data)
    }

    func saveOutputText(_ text: String, id: String, outputId: String) throws {
        let url = try outputURL(for: id, outputId: outputId)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url, options: [.atomic])
        Self.excludeFromBackup(url.deletingLastPathComponent())
        Self.excludeFromBackup(url)
    }

    func loadOutputText(id: String, outputId: String) -> String? {
        guard let url = try? outputURL(for: id, outputId: outputId),
              let data = try? Data(contentsOf: url) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// 删除整条录音(音频、转写、缓存的纪要)。生成过的对话不删,它们是普通对话。
    func delete(id: String) throws {
        let dir = try directory(for: id)
        let fm = FileManager.default
        guard fm.fileExists(atPath: dir.path) else { return }
        try fm.removeItem(at: dir)
    }

    /// 删除某一块音频(写了 0 帧的块)。
    func deleteAudio(id: String, fileName: String) {
        guard let url = try? audioURL(for: id, fileName: fileName) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - Backup exclusion

    /// 根目录、录音目录和其中所有文件都标上不备份。音频是在录的时候一块块生成的,
    /// 所以每关一块调用一次(幂等)。
    func applyBackupExclusion(id: String) {
        Self.excludeFromBackup(root)
        guard let dir = try? directory(for: id) else { return }
        Self.excludeFromBackup(dir)
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: dir, includingPropertiesForKeys: nil) else { return }
        for case let url as URL in enumerator {
            Self.excludeFromBackup(url)
        }
    }

    static func excludeFromBackup(_ url: URL) {
        var target = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? target.setResourceValues(values)
    }

    static func isExcludedFromBackup(_ url: URL) -> Bool {
        let fresh = URL(fileURLWithPath: url.path)
        return (try? fresh.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup) == true
    }

    /// 录音占用的空间(设置页、列表页脚显示)。
    func totalBytes() -> Int64 {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
        var total: Int64 = 0
        for case let url as URL in enumerator {
            total += Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return total
    }

    /// `url` 在录音根目录里面(备份导出用来跳过)。
    func contains(_ url: URL) -> Bool {
        let base = root.standardizedFileURL.resolvingSymlinksInPath().path
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        return path == base || path.hasPrefix(base.hasSuffix("/") ? base : base + "/")
    }

    // MARK: - Coding

    static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }

    static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }
}
