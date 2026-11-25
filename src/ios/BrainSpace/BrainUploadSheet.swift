//
//  BrainUploadSheet.swift
//  LeoPhoneAgent
//
//  [brain-space] 发到资料库:分片上传(每片 SHA-256 校验),断网或关掉 App 后重新打开会从断点续传;
//  状态分三段显示:收到 → 校验完整 → 理解。原件先存好,理解可以慢慢来。
//

import CryptoKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class BrainUploader: ObservableObject {
    static let shared = BrainUploader()

    struct Job: Codable, Identifiable, Equatable {
        var id: String            // local id
        var name: String
        var size: Int64
        var identity: String
        var localPath: String      // copy under Application Support/BrainUploads, removed once received
        var uploadId: String?
        var received: Int64 = 0
        var stage = 0              // 0 sending, 1 received, 2 verified, 3 understood
        var fileId: String?
        var error: String?
    }

    @Published private(set) var jobs: [Job] = []
    private var runningTasks: [String: Task<Void, Never>] = [:]
    private static let storeKey = "leo.brainSpace.uploads"
    private static let dir: URL = {
        let d = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BrainUploads", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    /// Resolve relative filename (or migrate legacy absolute path) under current Application Support/BrainUploads.
    private static func resolvedURL(for storedPath: String) -> URL? {
        guard !storedPath.isEmpty else { return nil }
        let fileName = (storedPath as NSString).lastPathComponent
        let current = dir.appendingPathComponent(fileName)
        if FileManager.default.fileExists(atPath: current.path) { return current }
        if storedPath.hasPrefix("/"), FileManager.default.fileExists(atPath: storedPath) {
            return URL(fileURLWithPath: storedPath)
        }
        return current
    }

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.storeKey),
           let saved = try? JSONDecoder().decode([Job].self, from: data) {
            jobs = saved.filter { $0.stage < 3 || $0.fileId != nil }.suffix(20).map { var j = $0; j.error = nil; return j }
        }
    }

    /// Copy the picked file into our own folder off the main thread so a resume never blocks UI or depends on a security-scoped URL.
    func add(fileAt url: URL, name: String) {
        let id = UUID().uuidString
        let fileName = id + "-" + name
        let dest = Self.dir.appendingPathComponent(fileName)
        let scoped = url.startAccessingSecurityScopedResource()
        jobs.insert(Job(id: id, name: name, size: 0, identity: "", localPath: fileName), at: 0)
        persist()
        let copyTask = Task { [weak self] in
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                let size: Int64 = try await Task.detached(priority: .userInitiated) {
                    try FileManager.default.copyItem(at: url, to: dest)
                    return (try dest.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
                }.value
                guard !Task.isCancelled, let self, self.jobs.contains(where: { $0.id == id }) else {
                    try? FileManager.default.removeItem(at: dest)
                    return
                }
                let identity = "ios:" + SHA256.hash(data: Data("\(name)|\(size)|\(id)".utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
                self.update(id) {
                    $0.size = size
                    $0.identity = identity
                    $0.localPath = fileName
                    $0.error = nil
                }
                self.runningTasks.removeValue(forKey: id)
                self.resume(id)
            } catch {
                guard let self else { return }
                self.runningTasks.removeValue(forKey: id)
                self.update(id) { $0.error = "读不到这个文件:\(error.localizedDescription)" }
            }
        }
        runningTasks[id] = copyTask
    }

    func resumeAll() { jobs.filter { $0.stage < 3 && $0.size > 0 }.forEach { resume($0.id) } }

    func resume(_ id: String) {
        guard runningTasks[id] == nil, let job = jobs.first(where: { $0.id == id }), job.size > 0 else { return }
        update(id) { $0.error = nil }
        runningTasks[id] = Task { [weak self] in
            guard let self else { return }
            defer { self.runningTasks.removeValue(forKey: id) }
            do {
                try await self.run(job)
            } catch is CancellationError {
                return
            } catch {
                self.update(id) { $0.error = error.localizedDescription }
            }
        }
    }

    func remove(_ id: String) {
        runningTasks.removeValue(forKey: id)?.cancel()
        if let j = jobs.first(where: { $0.id == id }), let fileURL = Self.resolvedURL(for: j.localPath) {
            try? FileManager.default.removeItem(at: fileURL)
        }
        jobs.removeAll { $0.id == id }
        persist()
    }

    private func run(_ start: Job) async throws {
        let api = BrainSpaceAPI.shared
        var job = start
        if job.stage == 0 || (job.stage == 1 && job.fileId == nil) {
            if job.uploadId == nil {
                let s: BrainUploadState = try await api.post("/upload/start", ["name": job.name, "size": job.size, "identity": job.identity])
                try Task.checkCancellation()
                job.uploadId = s.id
                update(job.id) { $0.uploadId = s.id }
            }
            guard let uid = job.uploadId else { return }
            if job.stage == 0 {
                let status: BrainUploadState = try await api.get("/upload/\(uid)")
                try Task.checkCancellation()
                var offset = Int64(status.received ?? 0)
                let chunk = Int64(status.chunk ?? 8 * 1024 * 1024)
                if status.state != "received" {
                    guard let fileURL = Self.resolvedURL(for: job.localPath) else {
                        throw BrainSpaceError.http(0, "找不到待上传的本地文件")
                    }
                    let totalSize = job.size
                    while offset < totalSize {
                        try Task.checkCancellation()
                        let readOffset = offset
                        let readLen = Int(min(chunk, totalSize - readOffset))
                        let (data, digest): (Data, String) = try await Task.detached(priority: .utility) {
                            let handle = try FileHandle(forReadingFrom: fileURL)
                            defer { try? handle.close() }
                            try handle.seek(toOffset: UInt64(readOffset))
                            guard let data = try handle.read(upToCount: readLen), !data.isEmpty else {
                                throw BrainSpaceError.http(0, "本地文件读取中断")
                            }
                            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                            return (data, digest)
                        }.value
                        try Task.checkCancellation()
                        let reply = try await api.postData("/upload/\(uid)", query: [("offset", String(offset))], body: data,
                                                           contentType: "application/octet-stream", extra: ["X-Chunk-SHA256": digest])
                        let r = try BrainSpaceAPI.decoder.decode(BrainUploadState.Chunk.self, from: reply)
                        offset = Int64(r.received)
                        update(job.id) { $0.received = offset }
                    }
                }
                update(job.id) { $0.stage = 1; $0.received = $0.size }
            }
            try Task.checkCancellation()
            let receipt: BrainUploadState.Receipt = try await api.post("/upload/\(uid)/finish", [:])
            job.fileId = receipt.fileId
            update(job.id) { $0.stage = 2; $0.fileId = receipt.fileId }
            if let fileURL = Self.resolvedURL(for: job.localPath) {
                try? FileManager.default.removeItem(at: fileURL)
            }
            update(job.id) { $0.localPath = "" }
        }
        guard let fid = job.fileId ?? jobs.first(where: { $0.id == job.id })?.fileId else { return }
        for _ in 0..<60 {
            try Task.checkCancellation()
            if let p = try? await api.get("/pipeline", query: [("ids", fid), ("limit", "1")], as: BrainPipelinePage.self),
               let stages = p.items.first?.stages,
               stages.first(where: { $0.key == "parsed" }).map({ ["done", "skipped"].contains($0.state) }) == true {
                update(job.id) { $0.stage = 3 }
                return
            }
            try await Task.sleep(for: .seconds(5))
        }
    }

    private func update(_ id: String, _ change: (inout Job) -> Void) {
        guard let i = jobs.firstIndex(where: { $0.id == id }) else { return }
        change(&jobs[i])
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(jobs) { UserDefaults.standard.set(data, forKey: Self.storeKey) }
    }
}

struct BrainUploadSheet: View {
    @EnvironmentObject private var model: BrainSpaceModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var uploader = BrainUploader.shared
    @State private var importing = false
    @State private var photoItems: [PhotosPickerItem] = []

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { importing = true } label: { Label("从文件选择", systemImage: "folder") }
                    PhotosPicker(selection: $photoItems, maxSelectionCount: 20, matching: .any(of: [.images, .videos])) {
                        Label("从相册选择", systemImage: "photo.on.rectangle")
                    }
                } footer: {
                    Text("每一片都会校验。断网或关掉 App 后再打开这里,会从断点接着传。")
                }
                if !uploader.jobs.isEmpty {
                    Section("上传") {
                        ForEach(uploader.jobs) { job in row(job) }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("发到资料库")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                if case .success(let urls) = result { urls.forEach { uploader.add(fileAt: $0, name: $0.lastPathComponent) } }
            }
            .onChange(of: photoItems) { _, items in
                photoItems = []
                Task { for item in items { await importPhoto(item) } }
            }
            .onAppear { uploader.resumeAll() }
        }
    }

    private func row(_ job: BrainUploader.Job) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(job.name).font(.subheadline.weight(.medium)).lineLimit(1)
                Spacer()
                Text(BrainFormat.bytes(Double(job.size))).font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 4) {
                ForEach(1...3, id: \.self) { s in
                    Capsule().fill(job.stage >= s ? BrainTheme.accent : Color(.systemFill)).frame(height: 4)
                }
            }
            HStack {
                Text(stageText(job)).font(.caption).foregroundStyle(job.error == nil ? Color.secondary : Color.red)
                Spacer()
                if job.error != nil, !job.localPath.isEmpty || job.fileId != nil {
                    Button("继续") { uploader.resume(job.id) }.font(.caption)
                }
                if job.stage >= 2 || job.localPath.isEmpty {
                    Button("移除") { uploader.remove(job.id) }.font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func stageText(_ job: BrainUploader.Job) -> String {
        if let e = job.error { return e }
        switch job.stage {
        case 0: return job.size > 0 ? "正在传 \(Int(Double(job.received) / Double(max(job.size, 1)) * 100))%" : "准备中"
        case 1: return "已收到,正在校验"
        case 2: return "校验完整,原件已存好;正在理解内容"
        default: return "已理解,可以搜到了"
        }
    }

    private func importPhoto(_ item: PhotosPickerItem) async {
        guard let file = try? await item.loadTransferable(type: BrainPickedFile.self) else {
            model.say("这张读不出来,换个方式试试"); return
        }
        uploader.add(fileAt: file.url, name: file.name)
        try? FileManager.default.removeItem(at: file.url)
    }
}

/// Photos hands us a temporary file; keep its original name and format (HEIC, MOV…).
struct BrainPickedFile: Transferable {
    let url: URL
    let name: String
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .item) { received in
            let dest = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: dest)
            return BrainPickedFile(url: dest, name: received.file.lastPathComponent)
        }
    }
}
