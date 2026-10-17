//
//  MacScreenSession.swift
//  MinisApp
//
//  [WP-51 R1 / WP-52 R2] 看 Mac 屏幕的视频流与操控:信令线格式、视频 / 截图的切换规则、
//  ICE 候选排序、`leo-input` DataChannel 的输入事件、触控板模式、HID → W3C 键码。
//  纯 Foundation / CoreGraphics,App 与逻辑测试共用;契约见 src/mac/leophone/docs/specs/leo-screen.md。
//

import CoreGraphics
import Foundation

// MARK: - Signalling (WP-51)

struct ScreenICEServer: Equatable, Sendable {
    var urls: [String]
    var username: String?
    var credential: String?
}

struct ScreenSessionPreflight: Equatable, Sendable {
    var iceServers: [ScreenICEServer]
    var tailnetOnly: Bool
    /// 现在开会话的话，输入通道会不会给(Mac 的「允许手机操控」+ 设备检查)。
    var control: Bool
}

struct ScreenSessionOpened: Equatable, Sendable {
    var sessionId: String
    var answer: String
    var iceServers: [ScreenICEServer]
    var expiresAtMs: Double?
    var control: Bool
    var tailnetOnly: Bool
}

struct ScreenSessionStats: Equatable, Sendable {
    var state: String
    var codec: String?
    var encoder: String?
    var fps: Double?
    var width: Int?
    var height: Int?
    var rttMs: Double?
    var localCandidate: String?
    var remoteCandidate: String?

    /// 状态行:「H.264 · 30 fps · 3 ms · tailnet」。
    var summary: String {
        var parts: [String] = []
        if let codec { parts.append(codec.replacingOccurrences(of: "video/", with: "")) }
        if let fps { parts.append("\(Int(fps.rounded())) fps") }
        if let rttMs { parts.append("\(Int(rttMs.rounded())) ms") }
        if let path = remoteCandidate ?? localCandidate {
            parts.append(ScreenCandidateTier.label(forStatsCandidate: path))
        }
        return parts.joined(separator: " · ")
    }
}

enum ScreenSessionWire {
    static let path = "/screen/session"
    static let inputLabel = "leo-input"
    static let defaultMaxFps = 30
    static let defaultMaxEdge = 1920
    static let maxCandidatesPerCall = 50

    static func iceServers(_ any: Any?) -> [ScreenICEServer] {
        guard let list = any as? [[String: Any]] else { return [] }
        return list.compactMap { item in
            let urls: [String]
            if let many = item["urls"] as? [String] { urls = many }
            else if let one = item["urls"] as? String { urls = [one] }
            else { return nil }
            guard !urls.isEmpty else { return nil }
            return ScreenICEServer(urls: urls, username: item["username"] as? String,
                                   credential: item["credential"] as? String)
        }
    }

    static func parsePreflight(_ data: Data) -> ScreenSessionPreflight? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return ScreenSessionPreflight(iceServers: iceServers(obj["ice_servers"]),
                                      tailnetOnly: obj["tailnet_only"] as? Bool ?? false,
                                      control: obj["control"] as? Bool ?? false)
    }

    static func openBody(offer: String, control: Bool, display: String? = nil,
                         maxFps: Int = defaultMaxFps, maxEdge: Int = defaultMaxEdge) -> Data {
        var body: [String: Any] = ["offer": offer,
                                   "max_fps": min(max(maxFps, 1), 60),
                                   "max_edge": min(max(maxEdge, 640), 4096)]
        if control { body["control"] = true }
        if let display, !display.isEmpty, display.allSatisfy(\.isNumber) { body["display"] = display }
        return (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data()
    }

    static func parseOpened(_ data: Data) -> ScreenSessionOpened? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = obj["session_id"] as? String, !id.isEmpty,
              let answer = obj["answer"] as? String, answer.hasPrefix("v=") else { return nil }
        return ScreenSessionOpened(sessionId: id, answer: answer, iceServers: iceServers(obj["ice_servers"]),
                                   expiresAtMs: (obj["expires_at"] as? NSNumber)?.doubleValue,
                                   control: obj["control"] as? Bool ?? false,
                                   tailnetOnly: obj["tailnet_only"] as? Bool ?? false)
    }

    struct Candidate: Equatable, Sendable {
        var candidate: String
        var sdpMid: String?
        var sdpMLineIndex: Int32
    }

    /// 一次最多 50 条，按路径优先级排好(tailnet → LAN → srflx → relay)。
    static func iceBodies(_ candidates: [Candidate]) -> [Data] {
        let sorted = candidates.enumerated().sorted { a, b in
            let ta = ScreenCandidateTier.tier(of: a.element.candidate).rawValue
            let tb = ScreenCandidateTier.tier(of: b.element.candidate).rawValue
            return ta != tb ? ta < tb : a.offset < b.offset
        }.map(\.element)
        return stride(from: 0, to: sorted.count, by: maxCandidatesPerCall).map { start in
            let chunk = sorted[start..<min(start + maxCandidatesPerCall, sorted.count)].map { c -> [String: Any] in
                var item: [String: Any] = ["candidate": c.candidate, "sdpMLineIndex": Int(c.sdpMLineIndex)]
                if let mid = c.sdpMid { item["sdpMid"] = mid }
                return item
            }
            return (try? JSONSerialization.data(withJSONObject: ["candidates": chunk], options: [.sortedKeys])) ?? Data()
        }
    }

    static func parseStats(_ data: Data) -> ScreenSessionStats? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let state = obj["state"] as? String else { return nil }
        return ScreenSessionStats(state: state, codec: obj["codec"] as? String, encoder: obj["encoder"] as? String,
                                  fps: (obj["frames_per_second"] as? NSNumber)?.doubleValue,
                                  width: (obj["frame_width"] as? NSNumber)?.intValue,
                                  height: (obj["frame_height"] as? NSNumber)?.intValue,
                                  rttMs: (obj["rtt_ms"] as? NSNumber)?.doubleValue,
                                  localCandidate: obj["local_candidate"] as? String,
                                  remoteCandidate: obj["remote_candidate"] as? String)
    }

    /// R1 新增的错误码说给人听;其余沿用 R0(MacScreenError.guidance)。
    static func guidance(for error: MacScreenError) -> String {
        switch error.code {
        case "session_limit": return "另一台设备正在看这台 Mac,先在那边关掉"
        case "negotiation_failed": return "视频没谈成，已改用截图"
        case "no_tailnet_path": return "Mac 设成了「只走 Tailscale」,但它没有 Tailscale 地址"
        case "peer_unavailable": return "Mac 上的视频服务没起来，已改用截图"
        case "session_not_found": return "视频会话已结束"
        case "ice_failed": return "视频连不通(网络不通),已改用截图"
        case "connect_timeout": return "视频连接超时，已改用截图"
        default: return error.guidance
        }
    }
}

/// 候选地址的路径等级(和 Mac 端一致):tailnet(100.64.0.0/10、fd7a:115c:a1e0::/48)→ LAN → 其他 host → srflx → relay。
enum ScreenCandidateTier: Int, Comparable {
    case tailnet = 0, lan, host, srflx, relay, unknown

    static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }

    static func tier(of candidate: String) -> ScreenCandidateTier {
        let fields = candidate.split(separator: " ").map(String.init)
        // candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> …
        guard let typIndex = fields.firstIndex(of: "typ"), typIndex + 1 < fields.count, fields.count > 4 else { return .unknown }
        switch fields[typIndex + 1] {
        case "relay": return .relay
        case "srflx", "prflx": return .srflx
        case "host": return addressTier(fields[4])
        default: return .unknown
        }
    }

    static func addressTier(_ address: String) -> ScreenCandidateTier {
        if isTailnet(address) { return .tailnet }
        if isPrivate(address) { return .lan }
        return .host
    }

    static func isTailnet(_ address: String) -> Bool {
        let lower = address.lowercased()
        if lower.hasPrefix("fd7a:115c:a1e0:") { return true }
        let octets = address.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        return octets[0] == 100 && (64...127).contains(octets[1])
    }

    static func isPrivate(_ address: String) -> Bool {
        let lower = address.lowercased()
        if lower.hasPrefix("fe80:") || lower.hasPrefix("fc") || lower.hasPrefix("fd") { return true }
        let o = address.split(separator: ".").compactMap { Int($0) }
        guard o.count == 4 else { return false }
        return o[0] == 10 || (o[0] == 172 && (16...31).contains(o[1])) || (o[0] == 192 && o[1] == 168)
    }

    /// Mac 状态里的 "host 100.81.83.56" / "prflx 100.70.0.9" → 「tailnet」「局域网」「中转」…
    static func label(forStatsCandidate text: String) -> String {
        let parts = text.split(separator: " ").map(String.init)
        let type = parts.first ?? ""
        let address = parts.count > 1 ? parts[1] : ""
        if type == "relay" { return "中转" }
        switch addressTier(address) {
        case .tailnet: return "Tailscale"
        case .lan: return "局域网"
        default: return type == "srflx" || type == "prflx" ? "公网直连" : "直连"
        }
    }
}

/// [WP-51] 视频优先，失败回退截图。视频是加分项：任何一步不成就用 R0 截图接着看。
enum ScreenViewModePolicy {
    enum Mode: Equatable { case video, snapshot }

    /// 回答之后这么久还没连上就算失败(Mac 端 30 s 过期，手机先放弃)。
    static let connectTimeout: TimeInterval = 15
    /// 视频失败后这么久内不再自动试(用户可以手动点「试视频」)。
    static let retryCooldown: TimeInterval = 60

    static func mode(screenSessionSupported: Bool, lastVideoFailure: Date?, userForcedSnapshot: Bool,
                     now: Date) -> Mode {
        guard screenSessionSupported, !userForcedSnapshot else { return .snapshot }
        if let failed = lastVideoFailure, now.timeIntervalSince(failed) < retryCooldown { return .snapshot }
        return .video
    }

    /// 这些错误重试也没用(权限、开关、只有一个观看者):别在冷却后又自动去碰。
    static func isPermanent(_ code: String) -> Bool {
        ["screen_disabled", "screen_scope_required", "screen_permission", "session_limit", "no_tailnet_path"].contains(code)
    }
}

// MARK: - Input events (WP-52)

enum ScreenInputEvent: Equatable {
    enum Button: String { case left, right, middle }
    enum Modifier: String, CaseIterable { case cmd, shift, alt, ctrl }
    enum KeyPhase: String { case press, down, up }

    case move(CGPoint)
    case down(Button, CGPoint?)
    case up(Button, CGPoint?)
    case click(Button, count: Int, at: CGPoint?)
    case scroll(dx: Double, dy: Double, at: CGPoint?)
    case key(code: String, mods: [Modifier], phase: KeyPhase)
    case text(String)

    static let maxTextPerMessage = 2000
    static let maxScroll: Double = 5000

    private static func clamp(_ v: CGFloat) -> Double { Double(min(max(v, 0), 1)) }

    private static func round4(_ v: Double) -> Double { (v * 10_000).rounded() / 10_000 }

    private func point(_ p: CGPoint?, into dict: inout [String: Any]) {
        guard let p else { return }
        dict["x"] = Self.round4(Self.clamp(p.x))
        dict["y"] = Self.round4(Self.clamp(p.y))
    }

    var json: [String: Any] {
        var d: [String: Any] = [:]
        switch self {
        case .move(let p):
            d["t"] = "move"; point(p, into: &d)
        case .down(let b, let p):
            d["t"] = "down"; d["b"] = b.rawValue; point(p, into: &d)
        case .up(let b, let p):
            d["t"] = "up"; d["b"] = b.rawValue; point(p, into: &d)
        case .click(let b, let n, let p):
            d["t"] = "click"; d["b"] = b.rawValue; d["n"] = min(max(n, 1), 3); point(p, into: &d)
        case .scroll(let dx, let dy, let p):
            d["t"] = "scroll"
            d["dx"] = min(max(dx, -Self.maxScroll), Self.maxScroll).rounded()
            d["dy"] = min(max(dy, -Self.maxScroll), Self.maxScroll).rounded()
            point(p, into: &d)
        case .key(let code, let mods, let phase):
            d["t"] = "key"; d["code"] = code
            if !mods.isEmpty { d["mods"] = Modifier.allCases.filter(mods.contains).map(\.rawValue) }
            if phase != .press { d["phase"] = phase.rawValue }
        case .text(let s):
            d["t"] = "text"; d["s"] = s
        }
        return d
    }

    /// 一个事件一条 UTF-8 JSON 消息(≤16 KB)。
    var message: String {
        guard let data = try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    /// 长文本拆成多条 text 事件:每条 ≤2000 个字符，按字形边界切，不拆坏 emoji / 组合字。
    static func textEvents(_ text: String) -> [ScreenInputEvent] {
        guard !text.isEmpty else { return [] }
        var out: [ScreenInputEvent] = []
        var current = ""
        var count = 0
        for ch in text {
            let n = ch.unicodeScalars.count
            if count + n > maxTextPerMessage, !current.isEmpty {
                out.append(.text(current)); current = ""; count = 0
            }
            current.append(ch); count += n
        }
        if !current.isEmpty { out.append(.text(current)) }
        return out
    }
}

/// Mac → 手机:`{"t":"status","ok":…,"reason":…}`。
struct ScreenInputStatus: Equatable {
    var ok: Bool
    var reason: String?

    static func parse(_ message: String) -> ScreenInputStatus? {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any],
              obj["t"] as? String == "status", let ok = obj["ok"] as? Bool else { return nil }
        return ScreenInputStatus(ok: ok, reason: obj["reason"] as? String)
    }

    var guidance: String? {
        guard !ok else { return nil }
        switch reason {
        case "accessibility": return "到 Mac 上给 LeoBot 打开辅助功能权限(系统设置 → 隐私与安全性 → 辅助功能)"
        case "helper_missing": return "Mac 端的输入组件不完整，重新安装 Mac 端后再试"
        default: return "Mac 暂时收不了操控"
        }
    }
}

enum ScreenControlGuidance {
    /// 开会话时要了操控、Mac 没给(开关没开 / 设备检查没过)。
    static let notGranted = "只能看、不能操控：在 Mac 的 设置 → 连接手机 → 屏幕 打开「允许手机操控」,再点「重新连接」"
}

/// 视频在视图里实际占的区域(等比缩放居中)。坐标要相对它算，不是相对视图边界。
enum ScreenGeometry {
    static func contentRect(videoSize: CGSize, in bounds: CGRect) -> CGRect {
        guard videoSize.width > 0, videoSize.height > 0, bounds.width > 0, bounds.height > 0 else { return bounds }
        let scale = min(bounds.width / videoSize.width, bounds.height / videoSize.height)
        let size = CGSize(width: videoSize.width * scale, height: videoSize.height * scale)
        return CGRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2,
                      width: size.width, height: size.height)
    }

    /// 视图里的点 → 视频帧里的归一化坐标(0–1,左上原点);落在黑边上返回 nil。
    static func normalized(_ location: CGPoint, contentRect: CGRect) -> CGPoint? {
        guard contentRect.width > 0, contentRect.height > 0,
              contentRect.insetBy(dx: -0.5, dy: -0.5).contains(location) else { return nil }
        return CGPoint(x: min(max((location.x - contentRect.minX) / contentRect.width, 0), 1),
                       y: min(max((location.y - contentRect.minY) / contentRect.height, 0), 1))
    }
}

/// [WP-52] iPhone 触控板模式:屏幕当触控板用，光标在 Mac 上相对移动。
/// 单指拖 = 移动、单指点按 = 左键、双指拖 = 滚动、长按 = 右键。
struct ScreenTrackpad: Equatable {
    /// 光标位置(归一化)。
    var cursor = CGPoint(x: 0.5, y: 0.5)
    /// 手指移过整块触控板宽度，光标移过 Mac 屏幕的这么多倍。
    var sensitivity: CGFloat = 1.2
    /// 双指滚动:手指 1 pt = Mac 上这么多像素。
    var scrollGain: Double = 2.0

    /// 单指移动 `delta`(pt),触控板大小 `padSize`。返回要发的 move 事件。
    /// Mac 屏幕宽高比(有视频尺寸时用视频的)。
    var screenAspect: CGFloat = 16.0 / 10.0

    mutating func move(by delta: CGSize, padSize: CGSize) -> ScreenInputEvent {
        guard padSize.width > 0, padSize.height > 0, screenAspect > 0 else { return .move(cursor) }
        // 两个方向都按触控板宽度换算：手指横竖移动同样距离，Mac 上光标也走同样距离。
        let unit = sensitivity / padSize.width
        cursor.x = min(max(cursor.x + delta.width * unit, 0), 1)
        cursor.y = min(max(cursor.y + delta.height * unit * screenAspect, 0), 1)
        return .move(cursor)
    }

    func tap() -> ScreenInputEvent { .click(.left, count: 1, at: cursor) }
    func doubleTap() -> ScreenInputEvent { .click(.left, count: 2, at: cursor) }
    func longPress() -> ScreenInputEvent { .click(.right, count: 1, at: cursor) }

    /// 双指拖动 `translation`(pt,向上为负 y)。契约:dy > 0 = 手指往上 = 内容往下滚。
    func scroll(by translation: CGSize) -> ScreenInputEvent {
        .scroll(dx: -Double(translation.width) * scrollGain, dy: -Double(translation.height) * scrollGain, at: cursor)
    }
}

/// [WP-52] iPad 外接键盘:GCKeyboard 的 HID usage → W3C `KeyboardEvent.code`。
enum ScreenHIDKeys {
    static func code(forUsage usage: Int) -> String? {
        switch usage {
        case 0x04...0x1D: return "Key" + String(UnicodeScalar(UInt8(65 + usage - 0x04)))
        case 0x1E...0x26: return "Digit\(usage - 0x1D)"
        case 0x27: return "Digit0"
        case 0x3A...0x45: return "F\(usage - 0x39)"
        case 0x68...0x6C: return "F\(usage - 0x68 + 13)"
        case 0x59...0x61: return "Numpad\(usage - 0x58)"
        default: return named[usage]
        }
    }

    private static let named: [Int: String] = [
        0x28: "Enter", 0x29: "Escape", 0x2A: "Backspace", 0x2B: "Tab", 0x2C: "Space",
        0x2D: "Minus", 0x2E: "Equal", 0x2F: "BracketLeft", 0x30: "BracketRight", 0x31: "Backslash",
        0x33: "Semicolon", 0x34: "Quote", 0x35: "Backquote", 0x36: "Comma", 0x37: "Period", 0x38: "Slash",
        0x39: "CapsLock", 0x49: "Insert", 0x4A: "Home", 0x4B: "PageUp", 0x4C: "Delete", 0x4D: "End",
        0x4E: "PageDown", 0x4F: "ArrowRight", 0x50: "ArrowLeft", 0x51: "ArrowDown", 0x52: "ArrowUp",
        0x54: "NumpadDivide", 0x55: "NumpadMultiply", 0x56: "NumpadSubtract", 0x57: "NumpadAdd",
        0x58: "NumpadEnter", 0x62: "Numpad0", 0x63: "NumpadDecimal",
        0xE0: "ControlLeft", 0xE1: "ShiftLeft", 0xE2: "AltLeft", 0xE3: "MetaLeft",
        0xE4: "ControlRight", 0xE5: "ShiftRight", 0xE6: "AltRight", 0xE7: "MetaRight",
    ]

    static func modifier(forUsage usage: Int) -> ScreenInputEvent.Modifier? {
        switch usage {
        case 0xE0, 0xE4: return .ctrl
        case 0xE1, 0xE5: return .shift
        case 0xE2, 0xE6: return .alt
        case 0xE3, 0xE7: return .cmd
        default: return nil
        }
    }

    /// iPadOS 先截走、GCKeyboard 看不到的组合键：工具条上给替代按钮，作为 key 事件发。
    struct Reserved: Equatable, Identifiable {
        var id: String { title }
        let title: String
        let code: String
        let mods: [ScreenInputEvent.Modifier]
    }

    static let reserved: [Reserved] = [
        .init(title: "⌘Tab", code: "Tab", mods: [.cmd]),
        .init(title: "⌘Space", code: "Space", mods: [.cmd]),
        .init(title: "⌘H", code: "KeyH", mods: [.cmd]),
        .init(title: "⌘⇧3", code: "Digit3", mods: [.cmd, .shift]),
        .init(title: "⌘⇧4", code: "Digit4", mods: [.cmd, .shift]),
        .init(title: "⌘⇧5", code: "Digit5", mods: [.cmd, .shift]),
    ]
}

/// [WP-52] iPhone 底部工具条:修饰键是「粘住」的,按下一个普通键(或方向键)时带上再松开。
struct ScreenStickyModifiers: Equatable {
    private(set) var held: Set<ScreenInputEvent.Modifier> = []

    mutating func toggle(_ m: ScreenInputEvent.Modifier) {
        if held.contains(m) { held.remove(m) } else { held.insert(m) }
    }

    func isHeld(_ m: ScreenInputEvent.Modifier) -> Bool { held.contains(m) }

    /// 发一个键：带上粘住的修饰键，然后全部松开(和 iOS 软键盘上的 ⇧ 一样只管一次)。
    mutating func press(_ code: String) -> ScreenInputEvent {
        let mods = ScreenInputEvent.Modifier.allCases.filter(held.contains)
        held = []
        return .key(code: code, mods: mods, phase: .press)
    }
}
