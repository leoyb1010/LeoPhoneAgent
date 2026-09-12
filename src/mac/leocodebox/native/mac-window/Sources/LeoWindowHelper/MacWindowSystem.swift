import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit
import WindowCore

@MainActor final class MacWindowSystem: WindowSystem {
    var nowMilliseconds: Double { Date().timeIntervalSince1970 * 1000 }

    func permissions() -> WindowPermissions {
        // Read-only probes. Consent is granted in System Settings to this signed
        // helper identity; a request never silently opens a permission prompt.
        WindowPermissions(accessibility: AXIsProcessTrusted(), screenCapture: CGPreflightScreenCaptureAccess(), postEvents: CGPreflightPostEventAccess())
    }
    func settle() async { try? await Task.sleep(nanoseconds: 50_000_000) }

    private func info(_ onScreen: Bool = false) throws -> [[String: Any]] {
        let options: CGWindowListOption = onScreen ? [.optionOnScreenOnly, .excludeDesktopElements] : [.optionAll, .excludeDesktopElements]
        guard let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            throw WindowFailure("observation-unavailable", "WindowServer did not return a window list.")
        }
        return rows
    }
    private func number(_ row: [String: Any], _ key: CFString) -> Int { (row[key as String] as? NSNumber)?.intValue ?? 0 }
    private func rect(_ row: [String: Any]) -> CGRect? {
        guard let dictionary = row[kCGWindowBounds as String] as? [String: Any] else { return nil }
        return CGRect(dictionaryRepresentation: dictionary as CFDictionary)
    }
    private func encode(_ rect: CGRect) -> String {
        [rect.origin.x, rect.origin.y, rect.width, rect.height].map { String(format: "%.3f", locale: Locale(identifier: "en_US_POSIX"), Double($0)) }.joined(separator: ",")
    }
    private func rect(_ encoded: String) throws -> CGRect {
        guard let b = WindowBounds(encoded) else { throw WindowFailure("window-changed", "Invalid window geometry.") }
        return CGRect(x: b.x, y: b.y, width: b.width, height: b.height)
    }
    private func scale(_ frame: CGRect) -> Double {
        NSScreen.screens.max { left, right in
            let l = displayRect(left).intersection(frame); let r = displayRect(right).intersection(frame)
            return max(0, l.width * l.height) < max(0, r.width * r.height)
        }.map { Double($0.backingScaleFactor) } ?? 1
    }
    private func displayRect(_ screen: NSScreen) -> CGRect {
        guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return .null }
        return CGDisplayBounds(id.uint32Value)
    }
    private func obscured(_ id: UInt32, bounds: CGRect, onScreen: [[String: Any]]) -> Bool {
        guard let index = onScreen.firstIndex(where: { number($0, kCGWindowNumber) == Int(id) }) else { return true }
        return onScreen.prefix(index).contains { row in
            guard number(row, kCGWindowLayer) >= 0,
                  (row[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0.01,
                  let other = rect(row) else { return false }
            let overlap = bounds.intersection(other)
            return !overlap.isNull && overlap.width > 1 && overlap.height > 1
        }
    }
    private func makeObservation(_ row: [String: Any], onScreen: [[String: Any]], granted: WindowPermissions) -> WindowObservation? {
        let pid = Int32(number(row, kCGWindowOwnerPID))
        let id = UInt32(number(row, kCGWindowNumber))
        guard pid > 0, id > 0, number(row, kCGWindowLayer) == 0,
              let bounds = rect(row), bounds.width > 1, bounds.height > 1,
              let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              let launchedAt = app.launchDate else { return nil }
        let onScreenIds = Set(onScreen.map { number($0, kCGWindowNumber) })
        let focusedPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let topAppWindow = onScreen.first { number($0, kCGWindowOwnerPID) == Int(pid) && number($0, kCGWindowLayer) == 0 }
        return WindowObservation(
            app: String((app.localizedName ?? app.bundleIdentifier ?? "Application").prefix(256)), pid: pid, windowId: String(id),
            title: String((row[kCGWindowName as String] as? String ?? "").prefix(2048)), bundleId: app.bundleIdentifier,
            processStartedAt: (launchedAt.timeIntervalSince1970 * 1000).rounded(),
            frontmost: focusedPid == pid && topAppWindow.map { number($0, kCGWindowNumber) == Int(id) } == true,
            bounds: encode(bounds), onScreen: onScreenIds.contains(Int(id)), occluded: obscured(id, bounds: bounds, onScreen: onScreen),
            scale: scale(bounds), permissions: granted)
    }
    func listWindows() throws -> [WindowObservation] {
        let visible = try info(true)
        let granted = permissions()
        return Array(try info().compactMap { makeObservation($0, onScreen: visible, granted: granted) }.prefix(128))
    }
    private func selected(_ ref: WindowIdentity) throws -> WindowObservation {
        guard let current = try listWindows().first(where: { $0.windowId == ref.windowId && $0.pid == ref.pid }) else {
            throw WindowFailure("window-gone", "The selected WindowServer window no longer exists.")
        }
        guard current.processStartedAt == ref.processStartedAt, ref.bundleId == nil || current.bundleId == ref.bundleId else {
            throw WindowFailure("window-changed", "The owning process was replaced.")
        }
        return current
    }

    private func value(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var result: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
        return result
    }
    private func text(_ element: AXUIElement, _ name: String, max: Int = 2048) -> String? {
        if let result = value(element, name) as? String { return String(result.prefix(max)) }
        return nil
    }
    private func children(_ element: AXUIElement) -> [AXUIElement] {
        var count: CFIndex = 0
        guard AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count) == .success, count > 0 else { return [] }
        var result: CFArray?
        guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, min(count, 256), &result) == .success else { return [] }
        return result as? [AXUIElement] ?? []
    }
    private func bool(_ element: AXUIElement, _ name: String) -> Bool? { (value(element, name) as? NSNumber)?.boolValue }
    private func frame(_ element: AXUIElement) -> CGRect? {
        guard let position = value(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
              let size = value(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero; var dimensions = CGSize.zero
        guard AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return nil }
        return CGRect(origin: point, size: dimensions)
    }
    private func geometryStatus(_ element: AXUIElement) -> String {
        return "role=\(text(element, kAXRoleAttribute) ?? "unknown") " + [kAXPositionAttribute, kAXSizeAttribute].map { name in
            var raw: CFTypeRef?
            let status = AXUIElementCopyAttributeValue(element, name as CFString, &raw)
            return "\(name)=\(status.rawValue)/type\(raw.map { CFGetTypeID($0) } ?? 0),AXValue=\(AXValueGetTypeID())"
        }.joined(separator: ",")
    }
    private func appElement(_ pid: Int32) -> AXUIElement {
        let app = AXUIElementCreateApplication(pid)
        // A hung application must not hold the service event loop. The host also
        // terminates this process at its request deadline.
        AXUIElementSetMessagingTimeout(app, 0.15)
        return app
    }
    private func matchingWindow(_ observation: WindowObservation) throws -> AXUIElement {
        guard AXIsProcessTrusted() else { throw WindowFailure("permission-denied", "Accessibility permission was not granted or was revoked.") }
        let app = appElement(observation.pid)
        var rawWindows: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &rawWindows)
        guard status == .success else {
            throw WindowFailure(status == .apiDisabled ? "permission-denied" : "element-unavailable", "The application window accessibility query failed (AX status \(status.rawValue)).")
        }
        var windows = rawWindows as? [AXUIElement] ?? []
        // Some accessibility providers omit or mis-shape AXWindows. Public
        // focused/main-window references and direct window children are valid
        // additional evidence, but only real AXWindow roles can be candidates.
        for name in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
            if let item = value(app, name), CFGetTypeID(item) == AXUIElementGetTypeID() { windows.append(item as! AXUIElement) }
        }
        windows.append(contentsOf: children(app).filter { text($0, kAXRoleAttribute) == "AXWindow" })
        var unique: [AXUIElement] = []
        for window in windows where text(window, kAXRoleAttribute) == "AXWindow" {
            if !unique.contains(where: { CFEqual($0, window) }) { unique.append(window) }
        }
        let expected = try rect(observation.bounds)
        let candidates = unique.filter { window in
            guard let bounds = frame(window), abs(bounds.minX - expected.minX) <= 1, abs(bounds.minY - expected.minY) <= 1,
                  abs(bounds.width - expected.width) <= 1, abs(bounds.height - expected.height) <= 1 else { return false }
            // WindowServer may redact titles without screen capture permission.
            return observation.title.isEmpty || text(window, kAXTitleAttribute) == observation.title
        }
        guard candidates.count == 1 else {
            throw WindowFailure(candidates.isEmpty ? "element-unavailable" : "target-ambiguous", "A unique accessibility window could not be matched. Expected \(observation.bounds); AX windows \(windows.count), bounds \(windows.prefix(1).map { frame($0).map(encode) ?? geometryStatus($0) }.joined(separator: ";")).")
        }
        // No private AX-window-number/CGS bridge. We match a unique public AX
        // window and re-read its geometry/title immediately before every action.
        return candidates[0]
    }
    private func descriptor(_ element: AXUIElement, path: [Int]) -> WindowElement {
        let role = text(element, kAXRoleAttribute, max: 128) ?? "AXUnknown"
        let subrole = text(element, kAXSubroleAttribute, max: 128)
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
        let title = text(element, kAXTitleAttribute) ?? text(element, kAXDescriptionAttribute)
        let identifier = text(element, kAXIdentifierAttribute, max: 256)
        let valueText: String? = secure ? nil : (text(element, kAXValueAttribute, max: 4096) ?? (value(element, kAXValueAttribute) as? NSNumber)?.stringValue)
        var settable = DarwinBoolean(false)
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        var names: CFArray?
        AXUIElementCopyActionNames(element, &names)
        let actions = Array((names as? [String] ?? []).prefix(20)).map { String($0.prefix(128)) }
        let bounds = frame(element).map(encode) ?? "0,0,0,0"
        let identity = [path.map(String.init).joined(separator: "."), role, subrole ?? "", identifier ?? "", title ?? "", valueText ?? "", bounds].joined(separator: "\u{001f}")
        return WindowElement(id: evidenceHash(identity), path: path, role: role, subrole: subrole, identifier: identifier, title: title,
            value: valueText, bounds: bounds, enabled: bool(element, kAXEnabledAttribute) ?? true,
            settableValue: !secure && settable.boolValue, actions: actions, redacted: secure, focused: bool(element, kAXFocusedAttribute) ?? false)
    }
    private func tree(_ root: AXUIElement) -> ([WindowElement], Bool) {
        var result: [WindowElement] = []
        var pending: [(AXUIElement, [Int])] = [(root, [])]
        var visited: [AXUIElement] = []
        var cursor = 0
        var byteCount = 0
        var truncated = false
        while cursor < pending.count && result.count < 256 {
            let (element, path) = pending[cursor]; cursor += 1
            if visited.contains(where: { CFEqual($0, element) }) { continue }
            visited.append(element)
            let item = descriptor(element, path: path)
            byteCount += (try? JSONEncoder().encode(item).count) ?? 0
            if byteCount > 96 * 1024 { truncated = true; break }
            result.append(item)
            if path.count < 8 && !item.redacted {
                let descendants = children(element)
                let capacity = max(0, 256 - pending.count)
                if descendants.count > capacity { truncated = true }
                for (index, child) in descendants.prefix(capacity).enumerated() { pending.append((child, path + [index])) }
            }
        }
        return (result, truncated || cursor < pending.count)
    }
    private func menuItems(_ pid: Int32) -> [WindowMenu] {
        guard let bar = value(appElement(pid), kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() else { return [] }
        var result: [WindowMenu] = []
        var budget = 0
        var visited: [AXUIElement] = []
        func walk(_ node: AXUIElement, prefix: [String], depth: Int) {
            guard result.count < 64, depth < 10, prefix.count < 6, budget < 24 * 1024, visited.count < 256, !visited.contains(where: { CFEqual($0, node) }) else { return }
            visited.append(node)
            let role = text(node, kAXRoleAttribute)
            var path = prefix
            if role == "AXMenuBarItem" || role == "AXMenuItem", let title = text(node, kAXTitleAttribute, max: 160), !title.isEmpty {
                path.append(title)
                let item = WindowMenu(path: path, enabled: bool(node, kAXEnabledAttribute) ?? true)
                budget += (try? JSONEncoder().encode(item).count) ?? 0
                if budget < 24 * 1024 { result.append(item) }
            }
            for child in children(node).prefix(64) { walk(child, prefix: path, depth: depth + 1) }
        }
        walk(bar as! AXUIElement, prefix: [], depth: 0)
        return result
    }
    private func resolve(_ id: String, in observation: WindowObservation, root: AXUIElement) throws -> AXUIElement {
        let matches = (observation.elements ?? []).filter { $0.id == id }
        guard matches.count == 1 else { throw WindowFailure("element-changed", "The element reference is missing or ambiguous.") }
        let expected = matches[0]
        var element = root
        for index in expected.path {
            let next = children(element)
            guard next.indices.contains(index) else { throw WindowFailure("element-changed", "The accessibility element path changed.") }
            element = next[index]
        }
        guard descriptor(element, path: expected.path) == expected else { throw WindowFailure("element-changed", "The accessibility element changed before execution.") }
        return element
    }
    private func image(_ observation: WindowObservation) async throws -> WindowImage {
        guard CGPreflightScreenCaptureAccess() else { throw WindowFailure("permission-denied", "Screen capture permission is required for an image.") }
        guard observation.onScreen else { throw WindowFailure("window-occluded", "The selected window is not on screen.") }
        let available: SCShareableContent
        do { available = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) }
        catch { throw WindowFailure("permission-denied", "ScreenCaptureKit could not access this window. Check the helper's screen capture permission.") }
        guard let window = available.windows.first(where: { String($0.windowID) == observation.windowId && $0.owningApplication?.processID == observation.pid }) else {
            throw WindowFailure("window-gone", "The selected window is no longer shareable.")
        }
        let bounds = try rect(observation.bounds)
        let factor = min(observation.scale, 1024 / max(bounds.width, bounds.height))
        let config = SCStreamConfiguration()
        config.width = max(1, Int((bounds.width * factor).rounded()))
        config.height = max(1, Int((bounds.height * factor).rounded()))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.ignoreGlobalClipSingleWindow = true
        if #available(macOS 14.2, *) { config.includeChildWindows = false }
        config.captureResolution = .nominal
        let captured: CGImage
        do { captured = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config) }
        catch {
            let failure = error as NSError
            throw WindowFailure("observation-unavailable", "The exact window screenshot could not be captured (\(failure.domain) / \(failure.code)).")
        }
        guard captured.width <= 1024, captured.height <= 1024,
              let bytes = NSBitmapImageRep(cgImage: captured).representation(using: .jpeg, properties: [.compressionFactor: 0.8]), bytes.count <= 1024 * 1024 else {
            throw WindowFailure("observation-unavailable", "The window image exceeded the capture budget.")
        }
        return WindowImage(data: bytes.base64EncodedString(), width: captured.width, height: captured.height,
            scaleX: Double(captured.width) / bounds.width, scaleY: Double(captured.height) / bounds.height, hash: evidenceHash(bytes))
    }

    func observe(_ ref: WindowIdentity, capture: Bool, elements: Bool) async throws -> WindowObservation {
        var observation = try selected(ref)
        if observation.permissions.accessibility && elements {
            let root = try matchingWindow(observation)
            observation.title = text(root, kAXTitleAttribute) ?? observation.title
            observation.minimized = bool(root, kAXMinimizedAttribute)
            if let focused = value(appElement(ref.pid), kAXFocusedWindowAttribute), CFGetTypeID(focused) == AXUIElementGetTypeID() {
                observation.frontmost = observation.frontmost && CFEqual(root, focused)
            }
            if elements {
                (observation.elements, observation.elementsTruncated) = tree(root)
                observation.menus = menuItems(ref.pid)
            }
        } else {
            observation.elements = []
        }
        if capture { observation.image = try await image(observation) }
        // A capture can yield while the target changes. Do not attach pixels to
        // the old geometry/process record after returning from ScreenCaptureKit.
        let final = try selected(ref)
        guard final.bounds == observation.bounds, final.processStartedAt == observation.processStartedAt else {
            throw WindowFailure("window-changed", "The target changed during observation.")
        }
        guard !observation.permissions.accessibility || final.permissions.accessibility,
              !capture || final.permissions.screenCapture else { throw WindowFailure("permission-denied", "Native observation permission was revoked.") }
        observation.permissions = final.permissions
        observation.frontmost = observation.frontmost && final.frontmost
        observation.occluded = final.occluded
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let elementsData = (try? encoder.encode(observation.elements ?? [])) ?? Data()
        observation.stateHash = evidenceHash(observation.title + "|" + elementsData.base64EncodedString())
        return observation
    }

    private func check(_ result: AXError) throws {
        guard result == .success else {
            throw WindowFailure(AXIsProcessTrusted() ? "execution-failed" : "permission-denied", "Accessibility did not accept the targeted operation.")
        }
    }
    private func pressMenu(_ path: [String], app: AXUIElement, pid: Int32, deadline: Double) async throws {
        guard let menuBar = value(app, kAXMenuBarAttribute), CFGetTypeID(menuBar) == AXUIElementGetTypeID() else {
            throw WindowFailure("element-unavailable", "This application does not expose an accessibility menu bar.")
        }
        var level = children(menuBar as! AXUIElement)
        for (index, name) in path.enumerated() {
            try beforeInput(deadline)
            guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { throw WindowFailure("background-blocked", "The foreground application changed during menu navigation.") }
            let matches = level.filter { text($0, kAXTitleAttribute) == name }
            guard matches.count == 1, bool(matches[0], kAXEnabledAttribute) != false else {
                throw WindowFailure(matches.count > 1 ? "target-ambiguous" : "element-unavailable", "The exact menu path is unavailable or disabled.")
            }
            let item = matches[0]
            try check(AXUIElementPerformAction(item, kAXPressAction as CFString))
            if index < path.count - 1 {
                await settle()
                guard AXIsProcessTrusted() else { throw WindowFailure("permission-denied", "Accessibility permission was revoked during menu navigation.") }
                let descendants = children(item)
                level = descendants.flatMap { text($0, kAXRoleAttribute) == "AXMenu" ? children($0) : [$0] }
            }
        }
    }

    private func beforeInput(_ deadline: Double) throws {
        guard nowMilliseconds <= deadline else { throw WindowFailure("snapshot-expired", "The snapshot expired before input. Observe again.") }
        guard AXIsProcessTrusted() else { throw WindowFailure("permission-denied", "Accessibility permission was revoked before input.") }
    }

    func perform(_ action: WindowAction, on window: WindowObservation, deadline: Double) async throws {
        guard AXIsProcessTrusted() else { throw WindowFailure("permission-denied", "Accessibility permission was revoked.") }
        let current = try selected(window.identity)
        guard current.bounds == window.bounds, current.scale == window.scale else { throw WindowFailure("window-changed", "The target moved before execution.") }
        if action.name != "focus" {
            guard current.frontmost else { throw WindowFailure("background-blocked", "The foreground window changed before input.") }
            guard current.onScreen && !current.occluded else { throw WindowFailure("window-occluded", "The target is obscured.") }
        }
        let root = try matchingWindow(window)
        try beforeInput(deadline)
        switch action.name {
        case "focus":
            guard let app = NSRunningApplication(processIdentifier: window.pid), app.activate(options: []) else {
                throw WindowFailure("execution-failed", "The selected application could not be activated.")
            }
            try check(AXUIElementPerformAction(root, kAXRaiseAction as CFString))
        case "minimize": try check(AXUIElementSetAttributeValue(root, kAXMinimizedAttribute as CFString, kCFBooleanTrue))
        case "press":
            guard let id = action.elementId else { throw WindowFailure("unsupported-action", "An element reference is required.") }
            let element = try resolve(id, in: window, root: root)
            try beforeInput(deadline)
            try check(AXUIElementPerformAction(element, kAXPressAction as CFString))
        case "setValue":
            guard let id = action.elementId, let replacement = action.value else { throw WindowFailure("unsupported-action", "A text element and value are required.") }
            let element = try resolve(id, in: window, root: root)
            let item = descriptor(element, path: [])
            guard !item.redacted, item.settableValue, ["AXTextField", "AXTextArea", "AXComboBox"].contains(item.role) else { throw WindowFailure("unsupported-action", "This text value is protected or not writable.") }
            try beforeInput(deadline)
            try check(AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, replacement as CFString))
        case "select":
            guard let path = action.path else { throw WindowFailure("unsupported-action", "An exact menu path is required.") }
            try await pressMenu(path, app: appElement(window.pid), pid: window.pid, deadline: deadline)
        case "click":
            guard CGPreflightPostEventAccess(), CGPreflightScreenCaptureAccess(), let x = action.x, let y = action.y,
                  x > 0, x < 1, y > 0, y < 1, action.coordinateSpace == "normalized-window" else {
                throw WindowFailure("permission-denied", "Coordinate input requires permission and normalized window coordinates.")
            }
            let bounds = try rect(window.bounds)
            let point = CGPoint(x: bounds.minX + x * bounds.width, y: bounds.minY + y * bounds.height)
            guard NSScreen.screens.contains(where: { displayRect($0).contains(point) }) else { throw WindowFailure("window-occluded", "The requested point is outside the visible displays.") }
            guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
                throw WindowFailure("execution-failed", "The coordinate events could not be created.")
            }
            down.setIntegerValueField(.mouseEventClickState, value: 1); up.setIntegerValueField(.mouseEventClickState, value: 1)
            // No await between down/up; cancellation/deadline is checked before
            // this pair, and the host treats a lost reply as indeterminate.
            let finalTarget = try selected(window.identity)
            guard finalTarget.frontmost, !finalTarget.occluded, finalTarget.onScreen,
                  finalTarget.bounds == window.bounds, finalTarget.scale == window.scale else {
                throw WindowFailure("window-changed", "The exact foreground target changed before coordinate input.")
            }
            try beforeInput(deadline)
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        default: throw WindowFailure("unsupported-action", "The native action is not supported.")
        }
    }
}
