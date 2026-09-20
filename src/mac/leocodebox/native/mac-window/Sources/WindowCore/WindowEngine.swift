import Foundation

@MainActor public protocol WindowSystem {
    var nowMilliseconds: Double { get }
    func permissions() -> WindowPermissions
    func listWindows() throws -> [WindowObservation]
    func observe(_ ref: WindowIdentity, capture: Bool, elements: Bool) async throws -> WindowObservation
    func perform(_ action: WindowAction, on window: WindowObservation, deadline: Double) async throws
    func settle() async
}

@MainActor public final class WindowEngine {
    private let system: any WindowSystem
    public init(system: any WindowSystem) { self.system = system }

    public func handle(_ request: WindowRequest) async -> WindowResponse {
        var attempted = false
        do {
            guard request.protocolVersion == 1 else { throw WindowFailure("invalid-request", "Unsupported native window protocol.") }
            if request.operation == "permissions" { return WindowResponse(ok: true, permissions: system.permissions()) }
            if request.operation == "list" { return WindowResponse(ok: true, permissions: system.permissions(), windows: Array(try system.listWindows().prefix(128))) }
            guard let ref = request.ref, ref.pid > 0, UInt32(ref.windowId) != nil, ref.processStartedAt != nil else {
                throw WindowFailure("invalid-request", "A native window and process identity is required.")
            }
            if request.operation == "observe" {
                let observation = try await system.observe(ref, capture: request.capture == true, elements: request.elements != false)
                try verifyIdentity(ref, observation)
                return WindowResponse(ok: true, observation: observation)
            }
            guard request.operation == "act", let action = request.action, action.supported(kind: request.kind ?? "") else {
                throw WindowFailure("unsupported-action", "An explicit supported window action is required.")
            }
            guard let expected = request.expected else { throw WindowFailure("invalid-request", "A prior native observation is required.") }
            try verifyIdentity(ref, expected)
            try requireFresh(request.expiresAt)
            try requirePermission(action)
            let before = try await system.observe(ref, capture: action.name == "click", elements: true)
            try verifyIdentity(ref, before)
            guard before.title == expected.title, before.bounds == expected.bounds, before.scale == expected.scale else {
                throw WindowFailure("window-changed", "The window title, geometry or display scale changed. Observe again.")
            }
            if action.name != "focus" {
                guard before.frontmost else { throw WindowFailure("background-blocked", "Only the selected foreground window may receive this action.") }
                guard before.onScreen && !before.occluded else { throw WindowFailure("window-occluded", "The target window is hidden or obscured. Observe again.") }
            }
            try validateElement(action, expected: expected, current: before)
            if action.name == "click" {
                guard let previousImage = expected.image, let currentImage = before.image else { throw WindowFailure("observation-unavailable", "Capture a fresh window image before coordinate input.") }
                guard previousImage.hash == currentImage.hash else { throw WindowFailure("scene-changed", "The window image changed. Observe again before clicking.") }
            }
            try requireFresh(request.expiresAt)
            try requirePermission(action)
            attempted = true
            try await system.perform(action, on: before, deadline: request.expiresAt!)
            for _ in 0..<4 {
                await system.settle()
                try requirePermission(action)
                let after = try await system.observe(ref, capture: action.name == "click", elements: true)
                try verifyIdentity(ref, after)
                if action.name == "click" && (!after.frontmost || after.occluded || after.bounds != before.bounds || after.scale != before.scale) {
                    throw WindowFailure("window-changed", "The foreground or window geometry changed after coordinate input. Its outcome is indeterminate.")
                }
                if let proof = verification(action, before: before, after: after) {
                    return WindowResponse(ok: true, observation: after, receipt: WindowReceipt(attempted: true, verified: true,
                        verification: proof, action: action.name, observedAt: system.nowMilliseconds))
                }
            }
            throw WindowFailure("verification-failed", "The input was delivered but its outcome could not be verified. Observe before retrying.")
        } catch {
            let failure = error as? WindowFailure ?? WindowFailure("execution-failed", "Native window operation failed.")
            return WindowResponse(ok: false, receipt: attempted ? WindowReceipt(attempted: true, verified: false, verification: "indeterminate",
                action: request.action?.name ?? "unknown", observedAt: system.nowMilliseconds) : nil,
                reason: failure.reason, message: failure.message)
        }
    }

    private func requireFresh(_ expiresAt: Double?) throws {
        guard let expiresAt, expiresAt.isFinite, system.nowMilliseconds <= expiresAt, expiresAt - system.nowMilliseconds <= 3000 else {
            throw WindowFailure("snapshot-expired", "The native snapshot expired before execution. Observe again.")
        }
    }
    private func requirePermission(_ action: WindowAction) throws {
        let permission = system.permissions()
        guard permission.accessibility else { throw WindowFailure("permission-denied", "Accessibility permission is not granted to the native helper.") }
        if action.name == "click" && (!permission.screenCapture || !permission.postEvents) {
            throw WindowFailure("permission-denied", "Coordinate input requires screen capture and event posting permissions.")
        }
        if action.name == "key" && !permission.postEvents {
            throw WindowFailure("permission-denied", "Named key input requires event posting permission.")
        }
        if (action.name == "scroll" || action.name == "drag") && !permission.postEvents {
            throw WindowFailure("permission-denied", "Scroll and drag require event posting permission.")
        }
    }
    private func verifyIdentity(_ expected: WindowIdentity, _ actual: WindowObservation) throws {
        guard expected.pid == actual.pid, expected.windowId == actual.windowId,
              expected.processStartedAt == actual.processStartedAt,
              expected.bundleId == nil || expected.bundleId == actual.bundleId else {
            throw WindowFailure("window-changed", "The selected window or owning process was replaced.")
        }
    }
    private func validateElement(_ action: WindowAction, expected: WindowObservation, current: WindowObservation) throws {
        guard action.name == "press" || action.name == "setValue" else { return }
        let oldMatches = (expected.elements ?? []).filter { $0.id == action.elementId }
        let newMatches = (current.elements ?? []).filter { $0.id == action.elementId }
        guard oldMatches.count == 1, newMatches.count == 1, oldMatches[0] == newMatches[0] else {
            throw WindowFailure("element-changed", "The selected accessibility element changed or is ambiguous. Observe again.")
        }
        let target = newMatches[0]
        guard target.enabled, !target.redacted else { throw WindowFailure("element-unavailable", "The target control is disabled or protected.") }
        if action.name == "press" && !target.actions.contains("AXPress") { throw WindowFailure("unsupported-action", "The target control does not support AXPress.") }
        if action.name == "setValue" && (!target.settableValue || !["AXTextField", "AXTextArea", "AXComboBox"].contains(target.role)) {
            throw WindowFailure("unsupported-action", "Only writable, non-secure text controls support setValue.")
        }
    }
    private func verification(_ action: WindowAction, before: WindowObservation, after: WindowObservation) -> String? {
        if action.name == "focus" { return after.frontmost ? "window-focused" : nil }
        if action.name == "minimize" { return after.minimized == true ? "minimized-readback" : nil }
        if action.name == "setValue", let old = before.elements?.first(where: { $0.id == action.elementId }),
           let changed = after.elements?.first(where: { $0.path == old.path && $0.role == old.role && $0.identifier == old.identifier }),
           !changed.redacted, changed.value == action.value { return "value-readback" }
        if ["press", "select", "click"].contains(action.name) {
            if let previous = before.stateHash, let current = after.stateHash, previous != current { return "observed-ui-change" }
            if let previous = before.image?.hash, let current = after.image?.hash, previous != current { return "observed-image-change" }
        }
        if action.name == "key" {
            return after.frontmost && after.bounds == before.bounds ? "key-posted" : nil
        }
        if action.name == "scroll" {
            return after.frontmost && after.bounds == before.bounds ? "scroll-posted" : nil
        }
        if action.name == "drag" {
            return after.frontmost && after.bounds == before.bounds ? "drag-posted" : nil
        }
        return nil
    }
}
