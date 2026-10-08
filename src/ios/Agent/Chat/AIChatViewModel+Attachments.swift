import Foundation
import UIKit
import UniformTypeIdentifiers

private let logger = AppLogger(category: "AIChatVM")

// MARK: - Attachment Management

extension AIChatViewModel {

    private var attachmentCacheDir: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return caches.appendingPathComponent("InputAttachments")
    }

    /// Save an image (from camera, drag-drop, or paste) to Caches and add as attachment.
    /// Encodes losslessly as PNG to preserve transparency and pixel fidelity for downstream
    /// tasks. Falls back to JPEG only if PNG encoding fails (extremely rare).
    /// When you have the original file bytes (e.g. from PhotosPicker `loadTransferable`),
    /// prefer ``addImageAttachment(data:fileExtension:originalDate:)`` so the original
    /// encoding is preserved verbatim.
    func addImageAttachment(_ image: UIImage, originalDate: Date? = nil) {
        let fm = FileManager.default
        let dir = attachmentCacheDir
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        // [T-ios-camera-capture-image-too-large] Built-in camera hands us a
        // full-resolution UIImage (~12MP). Saving it as lossless PNG /
        // jpegData(1.0) produced 15–25 MB attachments (GH#33 / #565), while
        // photo-library / screenshot images — which arrive as already-compressed
        // bytes — weigh only a few hundred KB to a few MB. Downsample + JPEG-
        // encode the capture so a single photo lands around 1–3 MB, matching the
        // library path. Fall back to a plain JPEG encode only if downsampling
        // can't produce data.
        guard let data = Self.downsampledCameraJPEG(image)
                ?? image.jpegData(compressionQuality: 0.82) else {
            return
        }
        let ext = "jpg"
        let fileName = "photo_\(UUID().uuidString.prefix(8)).\(ext)"
        let url = dir.appendingPathComponent(fileName)
        do {
            try data.write(to: url)
            if let date = originalDate {
                try? fm.setAttributes([.creationDate: date, .modificationDate: date], ofItemAtPath: url.path)
            }
            attachments.append(InputAttachment(fileName: fileName, cacheURL: url, kind: .image))
        } catch {
            logger.error("Failed to cache image attachment: \(error.localizedDescription)")
        }
    }

    /// Save an image attachment from raw file bytes (preferred when the source
    /// provides the original encoded data, e.g. PhotosPicker `loadTransferable(type: Data.self)`).
    /// The bytes are written verbatim — no decode/re-encode — so PNG transparency,
    /// HEIC, animated GIFs, and exact pixel data are preserved for downstream tasks.
    /// `fileExtension` should be the lowercase extension (e.g. "png", "heic", "jpg");
    /// if missing/unrecognised, magic bytes are sniffed.
    func addImageAttachment(data: Data, fileExtension: String?, originalDate: Date? = nil) {
        let fm = FileManager.default
        let dir = attachmentCacheDir
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        let knownImageExts = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff"]
        let normalizedExt: String = {
            if let e = fileExtension?.lowercased(), knownImageExts.contains(e) { return e }
            return Self.detectImageType(from: data) ?? "bin"
        }()
        let fileName = "photo_\(UUID().uuidString.prefix(8)).\(normalizedExt)"
        let url = dir.appendingPathComponent(fileName)
        do {
            try data.write(to: url)
            if let date = originalDate {
                try? fm.setAttributes([.creationDate: date, .modificationDate: date], ofItemAtPath: url.path)
            }
            attachments.append(InputAttachment(fileName: fileName, cacheURL: url, kind: .image))
        } catch {
            logger.error("Failed to cache image attachment data: \(error.localizedDescription)")
        }
    }

    // MARK: - Photo-picker placeholder + concurrent-load support

    /// Insert N `.loading` placeholder chips immediately (one per picked photo /
    /// video) so the user sees their selection the instant the picker dismisses,
    /// before any bytes load. Returns the placeholder IDs in order so the caller
    /// can resolve each one as its concurrent load finishes.
    func addLoadingPlaceholders(kinds: [InputAttachment.Kind]) -> [UUID] {
        let placeholders = kinds.map { InputAttachment.loadingPlaceholder(id: UUID(), kind: $0) }
        attachments.append(contentsOf: placeholders)
        return placeholders.map(\.id)
    }

    /// Resolve a `.loading` image placeholder with freshly loaded bytes: write
    /// the file and flip the chip to `.ready` in place (no reordering, so photos
    /// keep their picked order). If the placeholder was already removed by the
    /// user, the bytes are simply dropped.
    func finalizeImagePlaceholder(id: UUID, data: Data, fileExtension: String?, originalDate: Date? = nil) {
        guard let idx = attachments.firstIndex(where: { $0.id == id }) else { return }
        let fm = FileManager.default
        let dir = attachmentCacheDir
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        let knownImageExts = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff"]
        let normalizedExt: String = {
            if let e = fileExtension?.lowercased(), knownImageExts.contains(e) { return e }
            return Self.detectImageType(from: data) ?? "bin"
        }()
        let fileName = "photo_\(UUID().uuidString.prefix(8)).\(normalizedExt)"
        let url = dir.appendingPathComponent(fileName)
        do {
            try data.write(to: url)
            if let date = originalDate {
                try? fm.setAttributes([.creationDate: date, .modificationDate: date], ofItemAtPath: url.path)
            }
            // Re-find the index — the array may have shifted while we were on a
            // background hop — then mutate in place.
            guard let i = attachments.firstIndex(where: { $0.id == id }) else { return }
            attachments[i].fileName = fileName
            attachments[i].cacheURL = url
            attachments[i].kind = .image
            attachments[i].loadState = .ready
        } catch {
            logger.error("Failed to cache picked image: \(error.localizedDescription)")
            markPlaceholderFailed(id: id)
        }
    }

    /// Resolve a `.loading` video placeholder by copying the loaded file in and
    /// flipping to `.ready`. Mirrors `addFileAttachment` but targets an existing
    /// placeholder so the chip doesn't jump to the end.
    func finalizeVideoPlaceholder(id: UUID, from sourceURL: URL, originalDate: Date? = nil) {
        guard attachments.contains(where: { $0.id == id }) else { return }
        let fm = FileManager.default
        let dir = attachmentCacheDir
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let ext = sourceURL.pathExtension.isEmpty ? "mov" : sourceURL.pathExtension
        let fileName = "video_\(UUID().uuidString.prefix(8)).\(ext)"
        let destURL = dir.appendingPathComponent(fileName)
        do {
            try? fm.removeItem(at: destURL)
            try fm.copyItem(at: sourceURL, to: destURL)
            if let date = originalDate {
                try? fm.setAttributes([.creationDate: date, .modificationDate: date], ofItemAtPath: destURL.path)
            }
            guard let i = attachments.firstIndex(where: { $0.id == id }) else { return }
            attachments[i].fileName = fileName
            attachments[i].cacheURL = destURL
            attachments[i].kind = .video
            attachments[i].loadState = .ready
        } catch {
            logger.error("Failed to cache picked video: \(error.localizedDescription)")
            markPlaceholderFailed(id: id)
        }
    }

    /// Flip a placeholder to `.failed` so its chip shows an error state the user
    /// can dismiss. Leaves successfully-loaded siblings untouched.
    func markPlaceholderFailed(id: UUID) {
        guard let idx = attachments.firstIndex(where: { $0.id == id }) else { return }
        attachments[idx].loadState = .failed
    }

    /// True while any attachment is still loading — used to gate the send button.
    var hasLoadingAttachments: Bool {
        attachments.contains { $0.loadState == .loading }
    }

    /// Save a file picked via document picker to Caches and add as attachment.
    func addFileAttachment(from sourceURL: URL, originalDate: Date? = nil) {
        let fm = FileManager.default
        let dir = attachmentCacheDir
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        let fileName = sourceURL.lastPathComponent
        let destURL = dir.appendingPathComponent("\(UUID().uuidString.prefix(8))_\(fileName)")
        do {
            // sourceURL may be security-scoped
            let accessed = sourceURL.startAccessingSecurityScopedResource()
            defer { if accessed { sourceURL.stopAccessingSecurityScopedResource() } }
            try fm.copyItem(at: sourceURL, to: destURL)

            if let date = originalDate {
                try? fm.setAttributes([.creationDate: date, .modificationDate: date], ofItemAtPath: destURL.path)
            }

            // Classify the attachment. Files-app picks can surface images whose
            // UTType reports only public.data / whose name lacks a recognisable
            // extension (GH report: PNG from Files rendered the generic doc chip
            // while the same PNG from Photos previewed fine). Decide in order:
            //   1. the file's declared content type (resource values on the local
            //      copy — no security scope needed),
            //   2. the extension list,
            //   3. magic-byte sniff of the copied file's header (cheap 16-byte
            //      read — never loads the whole file).
            let kind: InputAttachment.Kind
            let ext = sourceURL.pathExtension.lowercased()
            let imageExts = ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tiff"]
            let videoExts = ["mp4", "mov", "m4v", "avi", "mkv"]
            let contentType = try? destURL.resourceValues(forKeys: [.contentTypeKey]).contentType
            if contentType?.conforms(to: .image) == true || imageExts.contains(ext) {
                kind = .image
            } else if contentType?.conforms(to: .movie) == true || videoExts.contains(ext) {
                kind = .video
            } else if Self.detectImageType(atFileURL: destURL) != nil {
                kind = .image
            } else {
                kind = .document
            }
            attachments.append(InputAttachment(fileName: fileName, cacheURL: destURL, kind: kind))
        } catch {
            logger.error("Failed to cache file attachment: \(error.localizedDescription)")
        }
    }

    /// Add an attachment from raw data (e.g. from Shortcuts IntentFile).
    /// Writes data to the attachment cache and appends to the attachments list.
    /// When the filename lacks a recognisable extension (common when receiving
    /// photos from Shortcuts variables), the data's magic bytes are inspected
    /// to determine the real file type and a correct extension is appended.
    func addDataAttachment(data: Data, fileName: String) {
        let fm = FileManager.default
        let dir = attachmentCacheDir
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)

        // Resolve kind and ensure the filename has a matching extension
        var resolvedName = fileName
        let ext = (fileName as NSString).pathExtension.lowercased()
        let kind: InputAttachment.Kind

        if ["jpg", "jpeg", "png", "gif", "webp", "heic"].contains(ext) {
            kind = .image
        } else if ["mp4", "mov", "m4v", "avi", "mkv"].contains(ext) {
            kind = .video
        } else if let detected = Self.detectImageType(from: data) {
            // No recognised extension — sniff magic bytes
            kind = .image
            if ext.isEmpty {
                resolvedName = "\(fileName).\(detected)"
            } else {
                // Has an unrecognised extension — replace it
                let stem = (fileName as NSString).deletingPathExtension
                resolvedName = "\(stem).\(detected)"
            }
        } else {
            kind = .document
        }

        let safeName = "\(UUID().uuidString.prefix(8))_\(resolvedName)"
        let url = dir.appendingPathComponent(safeName)
        do {
            try data.write(to: url)
            attachments.append(InputAttachment(fileName: resolvedName, cacheURL: url, kind: kind))
        } catch {
            logger.error("Failed to cache data attachment: \(error.localizedDescription)")
        }
    }

    /// Detect image format from data magic bytes. Returns a file extension string or nil.
    static func detectImageType(from data: Data) -> String? {
        guard data.count >= 4 else { return nil }
        let bytes = [UInt8](data.prefix(12))

        // JPEG: FF D8 FF
        if bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF { return "jpg" }
        // PNG: 89 50 4E 47
        if bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47 { return "png" }
        // GIF: 47 49 46 38
        if bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x38 { return "gif" }
        // WebP: RIFF....WEBP
        if data.count >= 12 && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46
            && bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50 { return "webp" }
        // HEIC/HEIF: ....ftypheic or ....ftypmif1 etc.
        if data.count >= 12 && bytes[4] == 0x66 && bytes[5] == 0x74 && bytes[6] == 0x79 && bytes[7] == 0x70 {
            let brand = String(bytes: Array(bytes[8..<12]), encoding: .ascii) ?? ""
            if brand.hasPrefix("heic") || brand.hasPrefix("heix") || brand.hasPrefix("mif1") { return "heic" }
        }
        // BMP: 42 4D ("BM")
        if bytes[0] == 0x42 && bytes[1] == 0x4D { return "bmp" }
        // TIFF: II*\0 (little-endian) or MM\0* (big-endian)
        if (bytes[0] == 0x49 && bytes[1] == 0x49 && bytes[2] == 0x2A && bytes[3] == 0x00)
            || (bytes[0] == 0x4D && bytes[1] == 0x4D && bytes[2] == 0x00 && bytes[3] == 0x2A) { return "tiff" }
        return nil
    }

    /// File-URL variant of ``detectImageType(from:)`` — reads only the first
    /// 16 bytes so classifying a multi-hundred-MB file never loads it into
    /// memory.
    static func detectImageType(atFileURL url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let head = try? handle.read(upToCount: 16), head.count >= 4 else { return nil }
        return detectImageType(from: head)
    }

    func removeAttachment(_ attachment: InputAttachment) {
        try? FileManager.default.removeItem(at: attachment.cacheURL)
        attachments.removeAll { $0.id == attachment.id }
    }

    /// Move an attachment from one position to another (drag-to-reorder).
    func moveAttachment(fromID: UUID, toID: UUID) {
        guard fromID != toID,
              let fromIndex = attachments.firstIndex(where: { $0.id == fromID }),
              let toIndex = attachments.firstIndex(where: { $0.id == toID }) else { return }
        attachments.move(fromOffsets: IndexSet(integer: fromIndex),
                         toOffset: toIndex > fromIndex ? toIndex + 1 : toIndex)
    }

    /// Return a unique filename inside `dir` by appending `_1`, `_2`, … when a collision exists.
    static func uniqueFileName(for name: String, in dir: URL) -> String {
        let fm = FileManager.default
        if !fm.fileExists(atPath: dir.appendingPathComponent(name).path) { return name }
        let nsName = name as NSString
        let stem = nsName.deletingPathExtension
        let ext = nsName.pathExtension
        var counter = 1
        while true {
            let candidate = ext.isEmpty ? "\(stem)_\(counter)" : "\(stem)_\(counter).\(ext)"
            if !fm.fileExists(atPath: dir.appendingPathComponent(candidate).path) { return candidate }
            counter += 1
        }
    }

    /// Clean up attachment chips from the UI (call after send).
    /// File cleanup is deferred — the async send block handles deletion after reading data.
    func clearAttachments() {
        attachments.removeAll()
    }

    /// Delete cached attachment files from disk (call after data has been read in async send block).
    nonisolated static func cleanupAttachmentFiles(_ items: [InputAttachment]) {
        let fm = FileManager.default
        for a in items {
            try? fm.removeItem(at: a.cacheURL)
        }
    }

    /// Process a list of InputAttachments: copy files to uploadsDir, build AttachmentMeta list,
    /// and build AgentContentPart list (image data parts + XML metadata block).
    /// Does NOT clean up the source cache files — caller is responsible.
    func processAttachments(
        _ attachments: [InputAttachment],
        uploadsDir: URL,
        nowStr: String
    ) -> (parts: [AgentContentPart], metas: [AttachmentMeta]) {
        let fm = FileManager.default
        var parts: [AgentContentPart] = []
        var metas: [AttachmentMeta] = []

        // The user's latest attachments always take priority: inline up to
        // `kImageContextKeepCount` of them regardless of how many images are
        // already in `agentHistory`. Older history images get evicted by the
        // next `trimOldImagesFromHistory` pass before the API call. Without
        // this, a long agent loop that already filled the image quota would
        // silently placeholder fresh user uploads — and the model, seeing
        // only `[image omitted ...]`, falls back to OCR or refuses to answer.
        let inlineBudget = Self.kImageContextKeepCount
        var inlinedImages = 0
        let canSeeImages = currentModelSupportsImageInput

        for (i, attachment) in attachments.enumerated() {
            let fileExists = fm.fileExists(atPath: attachment.cacheURL.path)
            logger.info("📎[QUEUE-DRAIN] attachment[\(i)] kind=\(String(describing: attachment.kind)) file=\(attachment.fileName) cacheExists=\(fileExists)")

            guard fileExists else {
                logger.error("📎[QUEUE-DRAIN]   FAILED — source missing at \(attachment.cacheURL.path)")
                continue
            }

            // [T-ios-attachment-oom-bg-kill] Stream the file to the uploads dir
            // and read its size from filesystem attributes — do NOT load it into
            // memory. Mirrors the SEND-ASYNC path fix: a large non-image
            // attachment (e.g. a 368 MB sysdiagnose) here would spike the app
            // footprint by its full size and let iOS jetsam-SIGKILL the process
            // on backgrounding. This QUEUE-DRAIN path runs for messages sent
            // WHILE the agent is busy (queued prompts), so it must be fixed too.
            let attrs = try? fm.attributesOfItem(atPath: attachment.cacheURL.path)
            // Preserve original file date if available (e.g. PHAsset creation date)
            let fileDate: Date = (attrs?[.modificationDate] as? Date) ?? Date()
            let fileSize = (attrs?[.size] as? Int) ?? 0

            let safeName = Self.uniqueFileName(for: attachment.fileName, in: uploadsDir)
            let destURL = uploadsDir.appendingPathComponent(safeName)
            do {
                try fm.copyItem(at: attachment.cacheURL, to: destURL)
            } catch {
                logger.error("📎[QUEUE-DRAIN]   FAILED to copy \(attachment.cacheURL.lastPathComponent) → \(destURL.path): \(error.localizedDescription)")
                continue
            }
            try? fm.setAttributes([.creationDate: fileDate, .modificationDate: fileDate], ofItemAtPath: destURL.path)
            let linuxPath = "/var/minis/attachments/uploads/\(safeName)"
            let meta = AttachmentMeta(path: linuxPath, size: fileSize, modified: fileDate)
            metas.append(meta)
            logger.info("📎[QUEUE-DRAIN]   saved \(safeName): \(fileSize) bytes → \(linuxPath)")

            // [T-ios-attachment-oom-bg-kill] Only IMAGES need bytes in memory
            // (resize/inline). Non-image attachments are already persisted above.
            guard attachment.kind == .image else { continue }
            guard let data = try? Data(contentsOf: attachment.cacheURL) else {
                logger.error("📎[QUEUE-DRAIN]   image load failed (kept on disk) \(attachment.cacheURL.path)")
                continue
            }

            if attachment.kind == .image {
                if canSeeImages, inlinedImages < inlineBudget {
                    let resized = Self.resizedImageData(data, maxLongEdge: 2000) ?? data
                    let ext = attachment.cacheURL.pathExtension.lowercased()
                    let mime: String
                    switch ext {
                    case "png": mime = resized.count == data.count ? "image/png" : "image/jpeg"
                    case "gif": mime = "image/gif"
                    case "webp": mime = "image/webp"
                    default: mime = "image/jpeg"
                    }
                    parts.append(.text("[attached image: \(linuxPath)]"))
                    parts.append(.imageData(data: resized, mimeType: mime, linuxPath: linuxPath))
                    inlinedImages += 1
                    logger.info("📎[QUEUE-DRAIN]   image \(inlinedImages)/\(inlineBudget) inlined for inference: \(resized.count) bytes, mime=\(mime)")
                } else {
                    let placeholder = Self.imagePlaceholderText(data: data, originalPath: linuxPath, snapshotPath: nil)
                    parts.append(.text(placeholder))
                    if !canSeeImages {
                        logger.info("📎[QUEUE-DRAIN]   image not inlined (active model has no vision), path-only placeholder for \(linuxPath)")
                    } else {
                        logger.info("📎[QUEUE-DRAIN]   image not inlined (budget \(inlineBudget) exhausted), placeholder added for \(linuxPath)")
                    }
                }
            }
        }

        // Build <user-attached-files> XML block
        if !metas.isEmpty {
            var xml = "<user-attached-files>\n"
            for meta in metas {
                xml += "  <file path=\"\(meta.path)\" url=\"\(meta.minisURL)\" size=\"\(meta.size)\" modified=\"\(nowStr)\" />\n"
            }
            xml += "</user-attached-files>"
            parts.append(.text(xml))
        }

        // When some images were omitted, tell the model how to proceed without
        // lying about vision on text-only bindings.
        let totalImageAttachments = attachments.filter { $0.kind == .image }.count
        if let reminder = AgentChatCorrectness.omittedImageReminder(
            inlined: inlinedImages,
            total: totalImageAttachments,
            supportsImageInput: canSeeImages,
            visionGroupConfigured: !canSeeImages && VisionGroupResolver.isConfigured
        ) {
            parts.append(.text(reminder))
        }

        return (parts, metas)
    }
}

// MARK: - Long-paste folding

/// [T-long-paste-fold] One folded paste. The draft only carries `token`;
/// `expandPastedBlocks(in:)` splices `text` back in at send time, so the
/// composer stays readable and the model still receives every character.
struct PastedBlock: Identifiable, Equatable {
    let id: UUID
    /// 1-based, unique among live blocks; shown as `[Pasted#N]`.
    let index: Int
    let text: String
    /// First non-blank line, at most 60 characters.
    let preview: String
    let charCount: Int

    var token: String { "[Pasted#\(index)]" }
}

extension AIChatViewModel {

    /// Fold `text` into a new block and hand it back so the caller can drop
    /// its token at the caret. Index = highest live index + 1, so a token
    /// already sitting in the draft is never reassigned.
    @discardableResult
    func registerPastedBlock(_ text: String) -> PastedBlock {
        let index = (pastedBlocks.map(\.index).max() ?? 0) + 1
        let firstLine = text
            .split(omittingEmptySubsequences: true, whereSeparator: \.isNewline)
            .first { !$0.allSatisfy(\.isWhitespace) }
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        let preview = firstLine.count > 60 ? String(firstLine.prefix(60)) + "…" : firstLine
        let block = PastedBlock(id: UUID(), index: index, text: text,
                                preview: preview, charCount: text.count)
        pastedBlocks.append(block)
        logger.info("[PasteFold] registered \(block.token) (\(block.charCount) chars)")
        return block
    }

    /// Blocks whose token is still in `text`, in the order they were pasted.
    func pastedBlocks(visibleIn text: String) -> [PastedBlock] {
        pastedBlocks.filter { text.contains($0.token) }
    }

    /// Drop blocks whose token the user deleted from the draft. Runs on every
    /// draft change, so it only writes when something actually went away.
    func prunePastedBlocks(against text: String) {
        guard pastedBlocks.contains(where: { !text.contains($0.token) }) else { return }
        pastedBlocks.removeAll { !text.contains($0.token) }
    }

    /// Remove one block and its token (plus the space the paste appended).
    func removePastedBlock(_ block: PastedBlock) {
        pastedBlocks.removeAll { $0.id == block.id }
        let draft = inputText
            .replacingOccurrences(of: block.token + " ", with: "")
            .replacingOccurrences(of: block.token, with: "")
        if draft != inputText { inputText = draft }
    }

    /// Splice every folded paste back into `text` for the model. A token with
    /// no live block (typed by hand) is left as-is.
    func expandPastedBlocks(in text: String) -> String {
        var expanded = text
        for block in pastedBlocks where expanded.contains(block.token) {
            expanded = expanded.replacingOccurrences(
                of: block.token,
                with: "<pasted-text n=\"\(block.index)\">\n\(block.text)\n</pasted-text>"
            )
        }
        return expanded
    }
}

// MARK: - Composer draft persistence

/// Unsent composer contents. `inputText` / attachments / folded pastes used to
/// live only in the VM, so an LRU eviction, memory warning or app kill lost
/// them silently.
struct ComposerDraftSnapshot {
    var text: String
    var attachments: [InputAttachment]
    var pastedBlocks: [PastedBlock]
    var treasuryContext: String? = nil

    var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty && pastedBlocks.isEmpty
            && (treasuryContext?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }

    /// Explicitly moved/selected material is additive, like the visible prompt.
    /// Keep both structured fragments intact instead of silently truncating one.
    static func mergedTreasuryContext(_ existing: String?, _ incoming: String?) -> String? {
        let values = [existing, incoming].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard let first = values.first else { return nil }
        return values.count == 1 || values[1] == first ? first : values.joined(separator: "\n")
    }
}

enum ComposerDraftStore {
    /// Drafts typed before a new chat has a session id.
    static let newChatKey = "__new_chat__"

    private struct Stored: Codable {
        /// `path` is relative to `attachmentsDirectory` (every composer
        /// attachment is cached there). Drafts saved by earlier builds hold an
        /// absolute path, which breaks once the app container moves.
        struct Attachment: Codable { let fileName: String; let path: String; let kind: String }
        struct Pasted: Codable { let index: Int; let text: String }
        let text: String
        let attachments: [Attachment]
        let pasted: [Pasted]
        // Optional for drafts saved by earlier app versions.
        let treasuryContext: String?
    }

    private static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ComposerDrafts", isDirectory: true)
    }

    /// Same folder as the view model's attachment cache.
    private static var attachmentsDirectory: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("InputAttachments", isDirectory: true)
    }

    /// [T-draft-relative-path] File name relative to `attachmentsDirectory`;
    /// anything stored elsewhere keeps its absolute path.
    private static func storedPath(for url: URL) -> String {
        let dir = attachmentsDirectory.standardizedFileURL.path + "/"
        let path = url.standardizedFileURL.path
        return path.hasPrefix(dir) ? String(path.dropFirst(dir.count)) : path
    }

    private static func resolvedURL(forStoredPath stored: String) -> URL? {
        let fm = FileManager.default
        guard stored.hasPrefix("/") else {
            let url = attachmentsDirectory.appendingPathComponent(stored)
            return fm.fileExists(atPath: url.path) ? url : nil
        }
        if fm.fileExists(atPath: stored) { return URL(fileURLWithPath: stored) }
        // Old absolute path from before the container moved (app update):
        // the file keeps its name inside the attachments folder.
        let moved = attachmentsDirectory.appendingPathComponent((stored as NSString).lastPathComponent)
        return fm.fileExists(atPath: moved.path) ? moved : nil
    }

    private static func fileURL(for key: String) -> URL {
        let safe = key.replacingOccurrences(of: "/", with: "_")
        return directory.appendingPathComponent("\(safe).json")
    }

    static func save(_ draft: ComposerDraftSnapshot, key: String) {
        let url = fileURL(for: key)
        guard !draft.isEmpty else {
            try? FileManager.default.removeItem(at: url)
            return
        }
        let stored = Stored(
            text: draft.text,
            attachments: draft.attachments.filter { $0.loadState == .ready }.map {
                .init(fileName: $0.fileName, path: storedPath(for: $0.cacheURL), kind: kindName($0.kind))
            },
            pasted: draft.pastedBlocks.map { .init(index: $0.index, text: $0.text) },
            treasuryContext: draft.treasuryContext
        )
        guard let data = try? JSONEncoder().encode(stored) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func load(key: String) -> ComposerDraftSnapshot? {
        guard let data = try? Data(contentsOf: fileURL(for: key)),
              let stored = try? JSONDecoder().decode(Stored.self, from: data) else { return nil }
        let attachments = stored.attachments.compactMap { a -> InputAttachment? in
            guard let url = resolvedURL(forStoredPath: a.path) else { return nil }
            return InputAttachment(fileName: a.fileName, cacheURL: url, kind: kind(named: a.kind))
        }
        let blocks = stored.pasted.map { p -> PastedBlock in
            let firstLine = p.text
                .split(omittingEmptySubsequences: true, whereSeparator: \.isNewline)
                .first { !$0.allSatisfy(\.isWhitespace) }
                .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
            let preview = firstLine.count > 60 ? String(firstLine.prefix(60)) + "…" : firstLine
            return PastedBlock(id: UUID(), index: p.index, text: p.text, preview: preview, charCount: p.text.count)
        }
        let snapshot = ComposerDraftSnapshot(text: stored.text, attachments: attachments, pastedBlocks: blocks,
                                             treasuryContext: stored.treasuryContext)
        return snapshot.isEmpty ? nil : snapshot
    }

    static func remove(key: String) {
        try? FileManager.default.removeItem(at: fileURL(for: key))
    }

    private static func kindName(_ kind: InputAttachment.Kind) -> String {
        switch kind {
        case .image: "image"
        case .video: "video"
        case .document: "document"
        }
    }

    private static func kind(named name: String) -> InputAttachment.Kind {
        switch name {
        case "image": .image
        case "video": .video
        default: .document
        }
    }
}

extension AIChatViewModel {
    var composerDraftKey: String { sessionId ?? ComposerDraftStore.newChatKey }

    var currentComposerDraft: ComposerDraftSnapshot {
        ComposerDraftSnapshot(text: inputText, attachments: attachments, pastedBlocks: pastedBlocks,
                              treasuryContext: pendingTreasuryContext)
    }

    /// What should survive a relaunch: while the composer is borrowed for
    /// editing a sent message, that's the user's own draft set aside, not the
    /// message being edited.
    private var persistableComposerDraft: ComposerDraftSnapshot {
        draftStashedForEdit ?? currentComposerDraft
    }

    func scheduleComposerDraftSave() {
        guard composerDraftPersistenceEnabled else { return }
        composerDraftSaveTask?.cancel()
        composerDraftSaveTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            self?.flushComposerDraft()
        }
    }

    func flushComposerDraft() {
        guard composerDraftPersistenceEnabled else { return }
        composerDraftSaveTask?.cancel()
        composerDraftSaveTask = nil
        ComposerDraftStore.save(persistableComposerDraft, key: composerDraftKey)
    }

    /// Restores the persisted draft into an empty composer and starts
    /// persisting further edits. Call once the VM's session id is known, and
    /// only for a VM the chat screen presents (CachedViewModel.init): headless
    /// senders must never get the user's draft. [T-draft-headless]
    func restoreComposerDraftIfNeeded() {
        if !composerDraftPersistenceEnabled {
            composerDraftPersistenceEnabled = true
            composerDraftBackgroundObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.flushComposerDraft() }
            }
        }
        guard currentComposerDraft.isEmpty, editingMessageIndex == nil,
              let saved = ComposerDraftStore.load(key: composerDraftKey) else { return }
        pastedBlocks = saved.pastedBlocks
        attachments = saved.attachments
        pendingTreasuryContext = saved.treasuryContext
        inputText = saved.text
        logger.info("🔑DRAFT [vm=\(self.vmInstanceId)] restored persisted draft text=\(saved.text.count)ch attachments=\(saved.attachments.count) key=\(self.composerDraftKey)")
    }

    /// Sets the composer aside (for message editing) and clears it.
    func stashComposerDraftForEdit() {
        guard draftStashedForEdit == nil else { return }
        draftStashedForEdit = currentComposerDraft
    }

    /// Sends `prompt` as its own turn without consuming the composer: the
    /// user's draft text, attachments and folded pastes stay where they are.
    func sendDetachedPrompt(_ prompt: String) {
        guard !isProcessing, editingMessageIndex == nil else { return }
        // [B4] Near the context limit send() parks the prompt for the "compact
        // first?" alert, and Cancel there puts it into the composer in place of
        // the draft. Say so up front instead and leave the composer alone.
        switch checkContextBeforeSend() {
        case .ok:
            break
        case .needsCompact where autoCompactEnabled || sessionSource == "shortcut":
            break // send() compacts and sends without asking
        case .needsCompact, .exhausted:
            transientNotice = String(localized: "Context is almost full. Compact the conversation first, then try again.")
            return
        }
        withComposerSetAside {
            inputText = prompt
            send()
        }
    }

    /// Transfer the complete composer only after photo loading has settled.
    func takeComposerForTransfer() -> ViewModelCache.PendingTransfer? {
        guard !hasLoadingAttachments else {
            transientNotice = String(localized: "Attachments are still loading. Try moving them again when loading finishes.")
            return nil
        }
        guard !currentComposerDraft.isEmpty else { return nil }
        let transfer = ViewModelCache.PendingTransfer(inputText: expandPastedBlocks(in: inputText),
            attachments: attachments, treasuryContext: pendingTreasuryContext)
        inputText = ""
        pastedBlocks = []
        attachments = []
        pendingTreasuryContext = nil
        return transfer
    }

    func appendTransferredComposer(_ transfer: ViewModelCache.PendingTransfer) {
        pendingTreasuryContext = ComposerDraftSnapshot.mergedTreasuryContext(pendingTreasuryContext, transfer.treasuryContext)
        if !transfer.inputText.isEmpty {
            if !inputText.isEmpty { inputText += "\n" }
            inputText += transfer.inputText
        }
        attachments += transfer.attachments
        flushComposerDraft()
    }

    /// [T-draft-headless] Headless senders (Siri / Shortcuts / widget quick
    /// tasks / WorkerPool / `minis-sessions send` / watch) borrow the composer
    /// for their own prompt only: `body` fills it and calls `send()`
    /// (synchronous up to the point where the composer is consumed). The
    /// user's unsent draft — text, attachments, folded pastes, a message being
    /// edited, a pending Treasury pick — is set aside first and put back
    /// afterwards, so an automated turn never sends it along or deletes its
    /// files.
    @discardableResult
    func withComposerSetAside<T>(_ body: () throws -> T) rethrows -> T {
        let draft = currentComposerDraft
        let editIndex = editingMessageIndex
        let editStash = draftStashedForEdit
        editingMessageIndex = nil
        draftStashedForEdit = nil
        pendingTreasuryContext = nil
        pastedBlocks = []
        attachments = []
        inputText = ""
        // defer:body 抛错(比如快捷指令派发失败)也要把用户的草稿放回去。
        defer {
            // Files the caller staged but send() refused to take go away with it.
            let leftovers = attachments.filter { staged in !draft.attachments.contains { $0.id == staged.id } }
            if !leftovers.isEmpty { Self.cleanupAttachmentFiles(leftovers) }
            pastedBlocks = draft.pastedBlocks
            attachments = draft.attachments
            inputText = draft.text
            pendingTreasuryContext = draft.treasuryContext
            draftStashedForEdit = editStash
            editingMessageIndex = editIndex
        }
        return try body()
    }

    /// [#33] "Context Full → New Session": the message that didn't fit becomes
    /// the new chat's draft instead of going back into this full chat.
    func movePendingSendToNewChatDraft() {
        showCompactBeforeSendPrompt = false
        showContextExhaustedPrompt = false
        let text = (pendingSendText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let moved = pendingSendAttachments
        let treasuryContext = pendingSendTreasuryContext
        pendingSendTreasuryContext = nil
        pendingSendText = nil
        pendingSendRawText = nil
        pendingSendPastedBlocks = []
        pendingSendAttachments = []
        guard !text.isEmpty || !moved.isEmpty || treasuryContext?.isEmpty == false else { return }
        // A new-chat draft that is already waiting stays; the message goes after it.
        var draft = ComposerDraftStore.load(key: ComposerDraftStore.newChatKey)
            ?? ComposerDraftSnapshot(text: "", attachments: [], pastedBlocks: [])
        if !text.isEmpty {
            draft.text = draft.text.isEmpty ? text : draft.text + "\n" + text
        }
        draft.attachments += moved
        draft.treasuryContext = ComposerDraftSnapshot.mergedTreasuryContext(draft.treasuryContext, treasuryContext)
        ComposerDraftStore.save(draft, key: ComposerDraftStore.newChatKey)
    }

    /// Puts back the draft set aside by `stashComposerDraftForEdit`.
    func restoreStashedComposerDraft() {
        guard let stash = draftStashedForEdit else { return }
        draftStashedForEdit = nil
        pastedBlocks = stash.pastedBlocks
        attachments = stash.attachments
        pendingTreasuryContext = stash.treasuryContext
        inputText = stash.text
    }
}
