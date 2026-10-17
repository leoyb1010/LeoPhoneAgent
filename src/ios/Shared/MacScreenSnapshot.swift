//
//  MacScreenSnapshot.swift
//  MinisApp / LeoWatch
//
//  [WP-50 R0] 看 Mac 的屏幕:轮询 `GET /screen/snapshot`(契约见
//  src/mac/leophone/docs/specs/leo-screen.md)。纯 Foundation,App、逻辑测试、手表共用。
//
//  - 直连(Tailscale)回二进制 JPEG + ETag 头,画面没变回 304;中继只能带 JSON,回
//    `{etag, data_base64, …}`,没变回 `{etag, not_modified: true}`。客户端两种都认,
//    路线由 LeoAgentClient 决定(直连优先),这里不用知道走的是哪条。
//  - ETag 同时放在 If-None-Match 头和 `if_none_match` 参数里:中继不转发请求头。
//  - 前台 1.5 s 一帧,中继同设备最快 1 帧/秒;退到后台就停。
//

import Foundation

struct MacScreenFrame: Equatable, Sendable {
    var jpeg: Data
    var etag: String
    var width: Int?
    var height: Int?
    var displayId: String?
    /// Mac 截下这一帧的时间(unix ms)。
    var capturedAtMs: Double?
}

struct MacScreenError: Error, Equatable, Sendable {
    var status: Int
    var code: String
    var message: String?
    var retryAfterMs: Double?

    /// 给人看的那一句:是谁的事、去哪里处理。
    var guidance: String {
        switch code {
        case "screen_disabled": return "在 Mac 的 设置 → 连接手机 → 屏幕 打开「允许手机查看屏幕」"
        case "screen_scope_required": return "这台设备没有看屏权限,重新扫码配对一次"
        case "screen_permission": return "到 Mac 上允许 LeoBot 屏幕录制(系统设置 → 隐私与安全性 → 屏幕录制)"
        case "rate_limited": return "请求太快,稍后自动继续"
        case "frame_too_large": return "画面太大,已改用更小的尺寸"
        case "display_not_found": return "那块屏幕不在了,改看主屏"
        case "capture_unavailable": return "Mac 上的 LeoBot 没在运行或截屏失败,稍后自动重试"
        case "not_supported": return "这台 Mac 上的 LeoBot 还不支持看屏,升级 Mac 端后再试"
        case "offline": return "连不上 Mac,稍后自动重试"
        default: return message?.isEmpty == false ? message! : "取画面失败(\(status))"
        }
    }

    /// 要人去处理的问题:停止轮询,等用户点「重试」。其余的退避后自动重试。
    var needsUser: Bool {
        ["screen_disabled", "screen_scope_required", "not_supported"].contains(code)
            || (status == 401)
    }
}

enum MacScreenSnapshotWire {
    static let path = "/screen/snapshot"
    /// 任务页 / iPad 右栏的默认尺寸:中继上限就是 1280。
    static let defaultMaxEdge = 1280
    static let defaultQuality = 0.6
    /// 手表:iPhone 代取 ≤400 px 的小图转过去(WatchConnectivity 单条消息上限约 64 KB)。
    static let watchMaxEdge = 400
    static let watchQuality = 0.5
    static let watchMaxBytes = 60_000

    enum Result: Equatable, Sendable {
        case frame(MacScreenFrame)
        case notModified(etag: String)
        case failure(MacScreenError)
    }

    /// 请求路径(含参数)。参数按契约夹紧,省得 Mac 端再改。
    static func requestPath(maxEdge: Int = defaultMaxEdge, quality: Double = defaultQuality,
                            display: String? = nil, etag: String? = nil) -> String {
        var items = [URLQueryItem(name: "max_edge", value: String(min(max(maxEdge, 320), 2560))),
                     URLQueryItem(name: "q", value: String(format: "%.2f", min(max(quality, 0.3), 0.9)))]
        if let display, !display.isEmpty, display.allSatisfy(\.isNumber) {
            items.append(URLQueryItem(name: "display", value: display))
        }
        if let etag, !etag.isEmpty { items.append(URLQueryItem(name: "if_none_match", value: etag)) }
        var parts = URLComponents()
        parts.path = path
        parts.queryItems = items
        // `"` in an ETag must be percent-encoded; URLComponents leaves it alone.
        let query = (parts.percentEncodedQuery ?? "").replacingOccurrences(of: "\"", with: "%22")
        return path + "?" + query
    }

    /// 解析一次响应。`headers` 的键不分大小写。
    static func parse(status: Int, headers: [String: String], data: Data) -> Result {
        let lower = Dictionary(headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { a, _ in a })
        if status == 304 {
            return .notModified(etag: lower["etag"] ?? "")
        }
        guard (200..<300).contains(status) else {
            return .failure(error(status: status, data: data))
        }
        let contentType = (lower["content-type"] ?? "").lowercased()
        if contentType.hasPrefix("image/") {
            guard !data.isEmpty, let etag = lower["etag"] else {
                return .failure(MacScreenError(status: status, code: "malformed", message: "画面数据不完整"))
            }
            return .frame(MacScreenFrame(jpeg: data, etag: etag,
                                         width: lower["x-leo-screen-width"].flatMap { Int($0) },
                                         height: lower["x-leo-screen-height"].flatMap { Int($0) },
                                         displayId: lower["x-leo-screen-display"],
                                         capturedAtMs: lower["x-leo-screen-captured-at"].flatMap { Double($0) }))
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .failure(MacScreenError(status: status, code: "malformed", message: "看不懂 Mac 回的画面"))
        }
        let etag = obj["etag"] as? String ?? ""
        if obj["not_modified"] as? Bool == true { return .notModified(etag: etag) }
        guard let b64 = obj["data_base64"] as? String, let jpeg = Data(base64Encoded: b64), !jpeg.isEmpty else {
            return .failure(MacScreenError(status: status, code: "malformed", message: "画面数据不完整"))
        }
        return .frame(MacScreenFrame(jpeg: jpeg, etag: etag,
                                     width: (obj["width"] as? NSNumber)?.intValue,
                                     height: (obj["height"] as? NSNumber)?.intValue,
                                     displayId: obj["display_id"] as? String,
                                     capturedAtMs: (obj["captured_at"] as? NSNumber)?.doubleValue))
    }

    /// `{ "error": { "message", "code" }, "retry_after_ms"? }`。旧 Mac 没有这个接口:404 且没有
    /// 看屏的错误码 → not_supported。
    static func error(status: Int, data: Data) -> MacScreenError {
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let err = obj?["error"] as? [String: Any]
        var code = err?["code"] as? String ?? ""
        let message = err?["message"] as? String ?? (obj?["error"] as? String)
        let retry = (obj?["retry_after_ms"] as? NSNumber)?.doubleValue
            ?? (err?["retry_after_ms"] as? NSNumber)?.doubleValue
        if code.isEmpty {
            switch status {
            case 404: code = "not_supported"
            case 428: code = "screen_permission"
            case 429: code = "rate_limited"
            case 413: code = "frame_too_large"
            case 502, 503, 504: code = "capture_unavailable"
            default: code = "http_\(status)"
            }
        }
        return MacScreenError(status: status, code: code, message: message, retryAfterMs: retry)
    }
}

/// [WP-50 R0] 轮询节奏。前台 1.5 s;出错按错误退避;要人处理的错误停下。
enum MacScreenPollPolicy {
    static let foregroundInterval: TimeInterval = 1.5
    /// 中继限速 1 帧/秒/设备:任何情况下两次请求至少隔这么久。
    static let minimumInterval: TimeInterval = 1.0
    static let maxBackoff: TimeInterval = 10
    /// 屏幕录制权限没给:人可能正在 Mac 上点,慢一点继续问。
    static let permissionRetry: TimeInterval = 5

    /// 下一次请求前等多久;nil = 停止,等用户点重试。
    static func nextDelay(after result: MacScreenSnapshotWire.Result, consecutiveFailures: Int) -> TimeInterval? {
        switch result {
        case .frame, .notModified:
            return foregroundInterval
        case .failure(let error):
            if error.needsUser { return nil }
            switch error.code {
            case "rate_limited":
                return max(minimumInterval, (error.retryAfterMs ?? 1000) / 1000)
            case "screen_permission":
                return permissionRetry
            default:
                let n = max(0, consecutiveFailures - 1)
                return min(maxBackoff, foregroundInterval * pow(2, Double(n)))
            }
        }
    }

    /// 413 时把尺寸降一档再试(1280 → 960 → 720 → 480,不低于 320)。
    static func reducedEdge(after error: MacScreenError, current: Int) -> Int? {
        guard error.code == "frame_too_large", current > 320 else { return nil }
        return max(320, current * 3 / 4)
    }
}

/// [WP-50 R0] 手表 ↔ iPhone 的小图转发(手表不直接连 Mac)。
enum MacScreenWatchRelay {
    static let kind = "screenThumb"
    static let etagKey = "etag"
    static let jpegKey = "jpeg"
    static let notModifiedKey = "notModified"
    static let errorKey = "error"
    static let hostKey = "host"
    /// 手表页面可见时的轮询间隔(省电:比手机慢)。
    static let watchInterval: TimeInterval = 3

    static func request(etag: String?) -> [String: Any] {
        var message: [String: Any] = ["kind": kind]
        if let etag, !etag.isEmpty { message[etagKey] = etag }
        return message
    }

    static func reply(_ result: MacScreenSnapshotWire.Result, host: String?) -> [String: Any] {
        var out: [String: Any] = [:]
        if let host { out[hostKey] = host }
        switch result {
        case .frame(let frame):
            out[jpegKey] = frame.jpeg
            out[etagKey] = frame.etag
        case .notModified(let etag):
            out[notModifiedKey] = true
            out[etagKey] = etag
        case .failure(let error):
            out[errorKey] = error.guidance
        }
        return out
    }

    enum Decoded: Equatable {
        case image(Data, etag: String)
        case unchanged
        case failed(String)
    }

    static func decode(_ reply: [String: Any]) -> Decoded {
        if let message = reply[errorKey] as? String { return .failed(message) }
        if reply[notModifiedKey] as? Bool == true { return .unchanged }
        if let jpeg = reply[jpegKey] as? Data, !jpeg.isEmpty {
            return .image(jpeg, etag: reply[etagKey] as? String ?? "")
        }
        return .failed("iPhone 没有回画面")
    }
}
