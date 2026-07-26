import Foundation

enum ArtifactKind: String, Codable, CaseIterable, Sendable {
    case document
    case image
    case audio
    case video
    case code
    case archive
    case file

    static func infer(mimeType: String, fileName: String) -> ArtifactKind {
        let mime = mimeType.lowercased()
        if mime.hasPrefix("image/") { return .image }
        if mime.hasPrefix("audio/") { return .audio }
        if mime.hasPrefix("video/") { return .video }
        if mime == "application/zip" || mime.contains("archive") { return .archive }
        if mime.hasPrefix("text/") || mime.contains("json") || mime.contains("xml") {
            let codeExtensions = Set(["swift", "m", "mm", "h", "py", "js", "ts", "tsx", "jsx", "html", "css", "sh", "json", "yaml", "yml"])
            return codeExtensions.contains(URL(fileURLWithPath: fileName).pathExtension.lowercased()) ? .code : .document
        }
        if mime == "application/pdf" { return .document }
        return .file
    }
}

struct ArtifactRecord: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let sessionId: String
    let sourceMessageId: String?
    var title: String
    var kind: ArtifactKind
    var mimeType: String
    var currentVersionId: String?
    let createdAt: Date
    var updatedAt: Date
    var trashedAt: Date?

    var isTrashed: Bool { trashedAt != nil }
}

struct ArtifactVersion: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let artifactId: String
    let versionNumber: Int
    let originalFileName: String
    let relativePath: String
    let byteCount: Int64
    let sha256: String
    let createdAt: Date
}

struct ArtifactSnapshot: Hashable, Sendable {
    let artifact: ArtifactRecord
    let currentVersion: ArtifactVersion?
}
