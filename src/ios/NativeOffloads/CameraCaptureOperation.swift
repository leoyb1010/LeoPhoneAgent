import Foundation

/// One capture request from its worker-thread dispatch through authorization,
/// presentation, file production and the terminal callback. Cancellation is
/// visible synchronously even while MainActor is blocked or has not started it.
@objc public final class CameraCaptureOperation: NSObject, @unchecked Sendable {
    @objc public let operationID = UUID().uuidString
    private let lock = NSLock()
    private var cancellation: String?
    private var completed = false

    struct CompletionClaim {
        let cancellationCode: String?
    }

    var acceptsResults: Bool {
        lock.lock(); defer { lock.unlock() }
        return !completed && cancellation == nil
    }

    @objc(requestCancellationWithTimedOut:)
    public func requestCancellation(timedOut: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard !completed, cancellation == nil else { return }
        cancellation = timedOut ? "timed_out" : "cancelled"
    }

    /// The terminal outcome and ownership of its callback are claimed under
    /// one lock. A cancellation racing this claim either wins and is returned,
    /// or follows an already-completed operation and is ignored.
    func takeCompletion() -> CompletionClaim? {
        lock.lock(); defer { lock.unlock() }
        guard !completed else { return nil }
        completed = true
        return CompletionClaim(cancellationCode: cancellation)
    }
}
