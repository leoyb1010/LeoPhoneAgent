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

    static func inferredMIMEType(fileName: String) -> String {
        switch URL(fileURLWithPath: fileName).pathExtension.lowercased() {
        case "txt", "md", "csv": return "text/plain"
        case "html", "htm": return "text/html"
        case "css": return "text/css"
        case "json": return "application/json"
        case "xml": return "application/xml"
        case "yaml", "yml": return "application/yaml"
        case "swift", "m", "mm", "h", "py", "js", "ts", "tsx", "jsx", "sh": return "text/plain"
        case "pdf": return "application/pdf"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "wav": return "audio/wav"
        case "mp4", "m4v": return "video/mp4"
        case "mov": return "video/quicktime"
        case "zip": return "application/zip"
        default: return "application/octet-stream"
        }
    }
}

struct ArtifactRecord: Identifiable, Codable, Hashable, Sendable {
    let id: String
    let sessionId: String
    let sourceMessageId: String?
    let sourcePath: String?
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

struct ArtifactSnapshot: Identifiable, Hashable, Sendable {
    let artifact: ArtifactRecord
    let currentVersion: ArtifactVersion?

    var id: String { artifact.id }
}
