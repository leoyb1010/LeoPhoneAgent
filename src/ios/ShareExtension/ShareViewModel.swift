import Foundation
import UIKit
import UniformTypeIdentifiers

/// Processes NSExtensionItems from the share sheet, saves files to the shared
/// container, and writes a PendingShare for the main app to consume.
final class ShareViewModel {
    private var pendingItems: [PendingShare.Item] = []
    private let inlineTextLimit = 1000
    /// [V-rec] 分享进来的音频(暂存名 `rec-xxxxxxxx_原名`)。可以转成录音纪要,也可以照常发到对话。
    private(set) var audioFileNames: [String] = []
    var hasAudio: Bool { !audioFileNames.isEmpty }
    static let pendingRecordingImportsKey = "recording.pendingImports"

    /// Process all extension items from the share context.
    func processExtensionItems(_ extensionItems: [NSExtensionItem]) async {
        pendingItems.removeAll()
        audioFileNames.removeAll()

        let fm = FileManager.default
        if let dir = SharedContainerStore.sharedFileDirectory {
            try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        }

        for extensionItem in extensionItems {
            guard let attachments = extensionItem.attachments else { continue }

            // [T-excerpt] 从阅读器/浏览器里选中一段文字再分享时,系统同时给出
            // 页面地址和选中的文字。原来的 if/else 只取地址、把文字丢了 ——
            // 摘录就变成了"又收藏了一遍整篇文章"。两个都在就两个都收:
            // 文字是内容,地址是出处。
            for provider in attachments {
                // [V-rec] 语音备忘录、文件 App 里的录音:先认成音频(public.audio)。
                if provider.hasItemConformingToTypeIdentifier(UTType.audio.identifier) {
                    await processAudio(provider)
                    continue
                }
                let hasURL = provider.hasItemConformingToTypeIdentifier(UTType.url.identifier)
                let hasText = provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
                if hasURL, hasText {
                    let before = pendingItems.count
                    await processText(provider)
                    await processURL(provider)
                    // 只分享页面(没选文字)时,plain-text 表示往往**就是**
                    // URL 本身 —— 那不是摘录,是同一条收藏两遍。
                    if pendingItems.count == before + 2,
                       pendingItems[before].value.trimmingCharacters(in: .whitespacesAndNewlines)
                        == pendingItems[before + 1].value.trimmingCharacters(in: .whitespacesAndNewlines) {
                        pendingItems.removeLast()
                    }
                } else if hasURL {
                    await processURL(provider)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    await processText(provider)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    await processImage(provider)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                    await processVideo(provider)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.item.identifier) {
                    await processFile(provider)
                }
            }
        }
    }

    /// Save pending share and return true on success.
    /// [T-share-buffer-merge] MERGE with any unconsumed previous share instead
    /// of overwriting it. Rapid consecutive shares (user shares screenshot A,
    /// then B a few seconds later, before the main app ran
    /// processPendingShare) used to silently lose A: this save() replaced the
    /// App Group record wholesale. Attachment file names are UUID-suffixed so
    /// the merged item lists never collide on disk. The 300s window matches
    /// checkForPendingShare's staleness cutoff; anything older is abandoned
    /// content whose files the main app will clean up.
    func save() -> Bool {
        guard !pendingItems.isEmpty else { return false }
        var items = pendingItems
        if let existing = SharedContainerStore.loadPendingShare(),
           Date().timeIntervalSince(existing.timestamp) < 300 {
            NSLog("[ShareExt] save: merging %d existing unconsumed items with %d new",
                  existing.items.count, pendingItems.count)
            items = existing.items + items
        }
        let share = PendingShare(items: items, timestamp: Date())
        SharedContainerStore.savePendingShare(share)
        return true
    }

    /// [V-rec] 转成录音:音频名单写进 App Group,主 App 经 `leophoneagent://recordings/import` 导入;
    /// 这些音频不再作为对话附件。返回是否有音频。
    func saveRecordingImports() -> Bool {
        guard hasAudio, let defaults = SharedContainerStore.sharedDefaults else { return false }
        let existing = defaults.stringArray(forKey: Self.pendingRecordingImportsKey) ?? []
        defaults.set(Array((existing + audioFileNames).suffix(10)), forKey: Self.pendingRecordingImportsKey)
        let names = Set(audioFileNames)
        pendingItems.removeAll { $0.kind == .attachment && names.contains($0.value) }
        return true
    }

    /// [T-collections] 收藏模式:把已处理的物料交给收藏库,不经 pendingShare。
    func builtShare() -> PendingShare {
        PendingShare(items: pendingItems, timestamp: Date())
    }

    // MARK: - Processors

    private func processURL(_ provider: NSItemProvider) async {
        guard let item = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier),
              let url = item as? URL else { return }

        // file:// URLs are local files — treat as file attachment, not inline text
        if url.isFileURL {
            await copyFileToShared(from: url)
            return
        }

        pendingItems.append(.init(kind: .inlineText, value: url.absoluteString))
    }

    /// Copy a local file URL to the shared container as an attachment.
    private func copyFileToShared(from url: URL) async {
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }

        // Preserve original bytes and format. Re-encoding before the raw save
        // can lose animation/metadata and makes a successful capture depend on
        // UIKit decoding.
        let originalName = url.lastPathComponent.isEmpty ? "file" : url.lastPathComponent
        let prefix = url.pathExtension.isEmpty ? "shared" : "shared-file"
        let fileName = "\(prefix)-\(UUID().uuidString.prefix(8))_\(originalName)"
        copyItemIfPossible(from: url, fileName: fileName)
    }

    private func processAudio(_ provider: NSItemProvider) async {
        guard let item = try? await provider.loadItem(forTypeIdentifier: UTType.audio.identifier) else { return }
        let ext = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
            .first { $0.conforms(to: .audio) }?.preferredFilenameExtension ?? "m4a"
        let prefix = "rec-\(UUID().uuidString.prefix(8))_"
        if let url = item as? URL, url.isFileURL {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            let name = url.lastPathComponent.isEmpty ? "audio.\(ext)" : url.lastPathComponent
            let fileName = prefix + name
            let before = pendingItems.count
            copyItemIfPossible(from: url, fileName: fileName)
            if pendingItems.count > before { audioFileNames.append(fileName) }
        } else if let data = item as? Data {
            let fileName = prefix + "audio.\(ext)"
            let before = pendingItems.count
            writeDataIfPossible(data, fileName: fileName)
            if pendingItems.count > before { audioFileNames.append(fileName) }
        }
    }

    private func processText(_ provider: NSItemProvider) async {
        guard let item = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier),
              let text = item as? String else { return }

        if text.count <= inlineTextLimit {
            pendingItems.append(.init(kind: .inlineText, value: text))
        } else {
            let fileName = "shared-text-\(UUID().uuidString.prefix(8)).txt"
            if let dir = SharedContainerStore.sharedFileDirectory,
               let data = text.data(using: .utf8),
               SharedContainerStore.stageData(data, to: dir, named: fileName) {
                    pendingItems.append(.init(kind: .attachment, value: fileName))
            }
        }
    }

    private func processImage(_ provider: NSItemProvider) async {
        if let item = try? await provider.loadItem(forTypeIdentifier: UTType.image.identifier) {
            if let url = item as? URL {
                await copyFileToShared(from: url)
                return
            }
            if let imageData = item as? Data {
                let ext = preferredImageExtension(for: provider) ?? "img"
                writeDataIfPossible(imageData,
                                    fileName: "shared-image-\(UUID().uuidString.prefix(8)).\(ext)")
                return
            }
            // Some share sources expose only a decoded UIImage. PNG is the
            // lossless fallback; raw URL/Data representations above are always
            // preferred when the provider supplies them.
            if let image = item as? UIImage, let pngData = image.pngData() {
                writeDataIfPossible(pngData,
                                    fileName: "shared-image-\(UUID().uuidString.prefix(8)).png")
            }
        }
    }

    private func processVideo(_ provider: NSItemProvider) async {
        guard let item = try? await provider.loadItem(forTypeIdentifier: UTType.movie.identifier),
              let url = item as? URL else { return }

        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }

        let ext = url.pathExtension.lowercased()
        let suffix = ext.isEmpty ? "mov" : ext
        let fileName = "shared-video-\(UUID().uuidString.prefix(8)).\(suffix)"
        copyItemIfPossible(from: url, fileName: fileName)
    }

    private func processFile(_ provider: NSItemProvider) async {
        guard let item = try? await provider.loadItem(forTypeIdentifier: UTType.item.identifier),
              let url = item as? URL else { return }

        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }

        let fileName = "shared-\(UUID().uuidString.prefix(8))_\(url.lastPathComponent)"
        copyItemIfPossible(from: url, fileName: fileName)
    }

    private func copyItemIfPossible(from sourceURL: URL, fileName: String) {
        guard SharedContainerStore.isSafeFileName(fileName),
              let directory = SharedContainerStore.sharedFileDirectory else { return }
        if SharedContainerStore.stageFile(from: sourceURL, to: directory, named: fileName) {
            pendingItems.append(.init(kind: .attachment, value: fileName))
        }
    }

    private func writeDataIfPossible(_ data: Data, fileName: String) {
        guard SharedContainerStore.isSafeFileName(fileName),
              let directory = SharedContainerStore.sharedFileDirectory else { return }
        if SharedContainerStore.stageData(data, to: directory, named: fileName) {
            pendingItems.append(.init(kind: .attachment, value: fileName))
        }
    }

    private func preferredImageExtension(for provider: NSItemProvider) -> String? {
        provider.registeredTypeIdentifiers.compactMap { identifier -> String? in
            guard let type = UTType(identifier), type.conforms(to: .image),
                  let ext = type.preferredFilenameExtension?.lowercased(),
                  ext.range(of: #"^[a-z0-9]{1,10}$"#, options: .regularExpression) != nil else {
                return nil
            }
            return ext
        }.first
    }
}
