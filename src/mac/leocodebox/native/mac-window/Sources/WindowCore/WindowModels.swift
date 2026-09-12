import Foundation
import CryptoKit

public struct WindowPermissions: Codable, Equatable, Sendable {
    public var accessibility: Bool
    public var screenCapture: Bool
    public var postEvents: Bool
    public init(accessibility: Bool, screenCapture: Bool, postEvents: Bool) {
        self.accessibility = accessibility; self.screenCapture = screenCapture; self.postEvents = postEvents
    }
}
public struct WindowIdentity: Codable, Equatable, Sendable {
    public var app: String
    public var pid: Int32
    public var windowId: String
    public var title: String
    public var bundleId: String?
    public var processStartedAt: Double?
    public init(app: String, pid: Int32, windowId: String, title: String, bundleId: String? = nil, processStartedAt: Double? = nil) {
        self.app = app; self.pid = pid; self.windowId = windowId; self.title = title; self.bundleId = bundleId; self.processStartedAt = processStartedAt
    }
}
public struct WindowElement: Codable, Equatable, Sendable {
    public var id: String
    public var path: [Int]
    public var role: String
    public var subrole: String?
    public var identifier: String?
    public var title: String?
    public var value: String?
    public var bounds: String
    public var enabled: Bool
    public var settableValue: Bool
    public var actions: [String]
    public var redacted: Bool
    public var focused: Bool
    public init(id: String, path: [Int], role: String, subrole: String? = nil, identifier: String? = nil, title: String? = nil, value: String? = nil,
                bounds: String, enabled: Bool, settableValue: Bool, actions: [String], redacted: Bool, focused: Bool = false) {
        self.id = id; self.path = path; self.role = role; self.subrole = subrole; self.identifier = identifier; self.title = title; self.value = value
        self.bounds = bounds; self.enabled = enabled; self.settableValue = settableValue; self.actions = actions; self.redacted = redacted; self.focused = focused
    }
}
public struct WindowMenu: Codable, Equatable, Sendable {
    public var path: [String]
    public var enabled: Bool
    public init(path: [String], enabled: Bool) { self.path = path; self.enabled = enabled }
}
public struct WindowImage: Codable, Equatable, Sendable {
    public var mimeType: String = "image/jpeg"
    public var data: String
    public var width: Int
    public var height: Int
    public var scaleX: Double
    public var scaleY: Double
    public var hash: String
    public init(data: String, width: Int, height: Int, scaleX: Double, scaleY: Double, hash: String) {
        self.data = data; self.width = width; self.height = height; self.scaleX = scaleX; self.scaleY = scaleY; self.hash = hash
    }
}
public struct WindowObservation: Codable, Equatable, Sendable {
    public var app: String
    public var pid: Int32
    public var windowId: String
    public var title: String
    public var bundleId: String?
    public var processStartedAt: Double
    public var frontmost: Bool
    public var bounds: String
    public var onScreen: Bool
    public var occluded: Bool
    public var scale: Double
    public var permissions: WindowPermissions
    public var elements: [WindowElement]?
    public var elementsTruncated: Bool?
    public var menus: [WindowMenu]?
    public var image: WindowImage?
    public var minimized: Bool?
    public var stateHash: String?
    public var identity: WindowIdentity {
        WindowIdentity(app: app, pid: pid, windowId: windowId, title: title, bundleId: bundleId, processStartedAt: processStartedAt)
    }
    public init(app: String, pid: Int32, windowId: String, title: String, bundleId: String? = nil, processStartedAt: Double,
                frontmost: Bool, bounds: String, onScreen: Bool, occluded: Bool, scale: Double, permissions: WindowPermissions,
                elements: [WindowElement]? = nil, elementsTruncated: Bool? = nil, menus: [WindowMenu]? = nil, image: WindowImage? = nil, minimized: Bool? = nil, stateHash: String? = nil) {
        self.app = app; self.pid = pid; self.windowId = windowId; self.title = title; self.bundleId = bundleId; self.processStartedAt = processStartedAt
        self.frontmost = frontmost; self.bounds = bounds; self.onScreen = onScreen; self.occluded = occluded; self.scale = scale; self.permissions = permissions
        self.elements = elements; self.elementsTruncated = elementsTruncated; self.menus = menus; self.image = image; self.minimized = minimized; self.stateHash = stateHash
    }
}
public struct WindowAction: Codable, Equatable, Sendable {
    public var name: String
    public var elementId: String?
    public var value: String?
    public var path: [String]?
    public var x: Double?
    public var y: Double?
    public var coordinateSpace: String?
    public init(name: String, elementId: String? = nil, value: String? = nil, path: [String]? = nil, x: Double? = nil, y: Double? = nil, coordinateSpace: String? = nil) {
        self.name = name; self.elementId = elementId; self.value = value; self.path = path; self.x = x; self.y = y; self.coordinateSpace = coordinateSpace
    }
    public func supported(kind: String) -> Bool {
        switch (kind, name) {
        case ("ax", "focus"), ("ax", "minimize"): return true
        case ("ax", "press"): return elementId?.isEmpty == false && elementId!.count <= 128
        case ("ax", "setValue"): return elementId?.isEmpty == false && elementId!.count <= 128 && value != nil && value!.count <= 4096
        case ("menu", "select"): return path != nil && (2...6).contains(path!.count) && path!.allSatisfy { !$0.isEmpty && $0.count <= 160 }
        case ("coord", "click"):
            return coordinateSpace == "normalized-window" && x != nil && y != nil && x!.isFinite && y!.isFinite && x! > 0 && x! < 1 && y! > 0 && y! < 1
        default: return false
        }
    }
}
public struct WindowRequest: Codable, Sendable {
    public var protocolVersion: Int = 1
    public var operation: String
    public var ref: WindowIdentity?
    public var expected: WindowObservation?
    public var expiresAt: Double?
    public var capture: Bool?
    public var elements: Bool?
    public var kind: String?
    public var action: WindowAction?
    public init(operation: String, ref: WindowIdentity? = nil, expected: WindowObservation? = nil, expiresAt: Double? = nil, capture: Bool? = nil, kind: String? = nil, action: WindowAction? = nil) {
        self.operation = operation; self.ref = ref; self.expected = expected; self.expiresAt = expiresAt; self.capture = capture; self.kind = kind; self.action = action
    }
}
public struct WindowReceipt: Codable, Equatable, Sendable {
    public var attempted: Bool
    public var verified: Bool
    public var verification: String
    public var action: String
    public var observedAt: Double
    public init(attempted: Bool, verified: Bool, verification: String, action: String, observedAt: Double) {
        self.attempted = attempted; self.verified = verified; self.verification = verification; self.action = action; self.observedAt = observedAt
    }
}
public struct WindowResponse: Codable, Sendable {
    public var protocolVersion: Int = 1
    public var ok: Bool
    public var permissions: WindowPermissions?
    public var windows: [WindowObservation]?
    public var observation: WindowObservation?
    public var receipt: WindowReceipt?
    public var reason: String?
    public var message: String?
    public init(ok: Bool, permissions: WindowPermissions? = nil, windows: [WindowObservation]? = nil, observation: WindowObservation? = nil,
                receipt: WindowReceipt? = nil, reason: String? = nil, message: String? = nil) {
        self.ok = ok; self.permissions = permissions; self.windows = windows; self.observation = observation; self.receipt = receipt; self.reason = reason; self.message = message.map { String($0.prefix(480)) }
    }
}
public struct WindowFailure: Error, Sendable {
    public let reason: String
    public let message: String
    public init(_ reason: String, _ message: String) { self.reason = reason; self.message = String(message.prefix(480)) }
}
public func evidenceHash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
public func evidenceHash(_ text: String) -> String { evidenceHash(Data(text.utf8)) }

public struct WindowBounds: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double
    public init?(_ encoded: String) {
        let parts = encoded.split(separator: ",", omittingEmptySubsequences: false).compactMap { Double($0) }
        guard parts.count == 4, parts.allSatisfy(\.isFinite), parts[2] > 0, parts[3] > 0 else { return nil }
        x = parts[0]; y = parts[1]; width = parts[2]; height = parts[3]
    }
}
