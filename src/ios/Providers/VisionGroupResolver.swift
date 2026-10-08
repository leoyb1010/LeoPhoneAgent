import Foundation

private let logger = AppLogger(category: "VisionGroup")

/// [T-ios-vision-group #182] Image understanding for main models that cannot see.
///
/// A "Vision Group" is an ordinary `ModelGroup` that `ProviderConfig.visionGroupId`
/// points at — not a new group kind, so member ordering and the group UI come for free
/// and `ModelGroup` (and its iCloud sync) stay untouched; the pointer itself is
/// per-device local state, like the voice group selectors.
///
/// Flow: when the session's model has no `.imageInput` modality but a Vision Group is
/// configured, `read_image` is still registered. The tool sends the image to a
/// vision-capable member and returns its DESCRIPTION as tool text (framed as untrusted
/// data, naming the model), so the main model learns the content without receiving
/// pixels it cannot decode. Pure text pieces live in `VisionGroupText`.
@MainActor
enum VisionGroupResolver {

    /// At most this many members are tried per image (a systemic outage must not walk a
    /// large group one request at a time).
    static let maxAttempts = 3
    /// Per-attempt ceiling: the agent path has no timeout of its own (URLSession 600 s),
    /// and a hung describe call would stall the tool call and the agent loop with it.
    static let perAttemptTimeout: TimeInterval = 90

    /// True when the pointer resolves to a group with at least one usable image-capable
    /// member. Also refreshes the thread-safe mirror the request serializers read.
    static var isConfigured: Bool {
        let configured = !candidates().isEmpty
        VisionGroupText.setConfiguredCached(configured)
        return configured
    }

    /// Usable image-capable members, in the group's order (`.loadBalance` rotated by
    /// `seed`). Membership is resolved PER MEMBER; a dangling reference is skipped,
    /// never fatal.
    ///
    /// Credentials are deliberately NOT checked here (unlike main routing, which keeps
    /// its credential-availability rules): a Keychain probe can read false on a cold
    /// launch or before first unlock, and hiding `read_image` for that leaves the model
    /// unable even to try. A missing credential is a request-time failure, reported per
    /// model by `describe` in the tool result.
    static func candidates(seed: Int = 0) -> [ModelEntry] {
        let store = ProviderConfigStore.shared
        guard let gid = store.visionGroupId, let group = store.group(for: gid) else { return [] }
        var members = group.memberEntryIds.compactMap { entryId -> ModelEntry? in
            guard let entry = store.entry(for: entryId),
                  !entry.isHidden,
                  entry.model.capabilities.supportedModalities.contains(.imageInput),
                  let instance = store.instance(for: entry.providerInstanceId),
                  instance.isEnabled else { return nil }
            return entry
        }
        if group.strategy == .loadBalance, members.count > 1 {
            let offset = abs(seed) % members.count
            members = Array(members[offset...] + members[..<offset])
        }
        return members
    }

    /// Name of the configured Vision Group, for UI/logging. nil when unset.
    static func groupName() -> String? {
        guard let gid = ProviderConfigStore.shared.visionGroupId,
              let group = ProviderConfigStore.shared.group(for: gid) else { return nil }
        return group.name
    }

    enum VisionError: LocalizedError {
        case notConfigured
        case allCandidatesFailed(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured:
                return "No vision-capable model is available in the configured Vision Group."
            case .allCandidatesFailed(let detail):
                return detail
            }
        }
    }

    /// A completed describe: WHICH model produced the text and what failed before it.
    struct VisionOutcome {
        let modelName: String
        let description: String
        let priorFailures: [(model: String, reason: String)]
    }

    /// Per-candidate progress, reported before each attempt so the UI can name the model.
    struct VisionAttempt {
        let index: Int
        let total: Int
        let modelName: String
    }

    /// Walk up to `maxAttempts` candidates and return the first real description. Empty
    /// replies and blind replies ("I didn't receive an image") fall through to the next
    /// member. Throws `allCandidatesFailed` with every model's own reason.
    static func describe(
        imageData: Data,
        mimeType: String,
        customPrompt: String? = nil,
        seed: Int = 0,
        onAttempt: (@MainActor (VisionAttempt) -> Void)? = nil
    ) async throws -> VisionOutcome {
        let entries = candidates(seed: seed)
        guard !entries.isEmpty else {
            logger.warning("[Vision] no usable candidates — configuredPointer=\(ProviderConfigStore.shared.visionGroupId != nil)")
            throw VisionError.notConfigured
        }
        let instruction = VisionGroupText.instruction(customPrompt: customPrompt)
        let attempts = Array(entries.prefix(maxAttempts))
        var failures: [(model: String, reason: String)] = []
        // Metadata only — never the image or the model's reply.
        logger.info("[Vision] describe start candidates=\(entries.count) attempting=\(attempts.count) "
            + "bytes=\(imageData.count) mime=\(mimeType) customPrompt=\(customPrompt?.isEmpty == false)")

        for (idx, entry) in attempts.enumerated() {
            let name = displayName(for: entry)
            onAttempt?(VisionAttempt(index: idx + 1, total: attempts.count, modelName: name))
            do {
                let text = try await describeOnce(entry: entry, imageData: imageData, mimeType: mimeType,
                                                  instruction: instruction)
                let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty {
                    failures.append((model: name, reason: "returned an empty description"))
                    logger.warning("[Vision] attempt \(idx + 1)/\(attempts.count) model=\(entry.model.id) result=empty")
                    continue
                }
                if VisionGroupText.looksBlind(trimmed) {
                    failures.append((model: name, reason: "replied that it received no image"))
                    logger.warning("[Vision] attempt \(idx + 1)/\(attempts.count) model=\(entry.model.id) result=blind chars=\(trimmed.count)")
                    continue
                }
                logger.info("[Vision] attempt \(idx + 1)/\(attempts.count) model=\(entry.model.id) result=ok chars=\(trimmed.count)")
                return VisionOutcome(modelName: name, description: trimmed, priorFailures: failures)
            } catch {
                let reason = (error as? VisionError)?.errorDescription ?? error.localizedDescription
                failures.append((model: name, reason: reason))
                logger.warning("[Vision] attempt \(idx + 1)/\(attempts.count) model=\(entry.model.id) result=error")
            }
        }
        let detail = failures.isEmpty
            ? "all vision models failed"
            : failures.map { "\($0.model): \($0.reason)" }.joined(separator: "; ")
        logger.error("[Vision] describe FAILED — all \(attempts.count) candidate(s) exhausted")
        throw VisionError.allCandidatesFailed(detail)
    }

    /// Model display name qualified by its provider instance (two instances of the same
    /// model are otherwise indistinguishable).
    static func displayName(for entry: ModelEntry) -> String {
        let model = entry.model.displayName.isEmpty ? entry.model.id : entry.model.displayName
        if let inst = ProviderConfigStore.shared.instance(for: entry.providerInstanceId), !inst.label.isEmpty {
            return "\(model) (\(inst.label))"
        }
        return model
    }

    /// One describe request against one entry: thinking OFF (some models otherwise
    /// return a reasoning-only empty body), no tools, bounded by `perAttemptTimeout`.
    private static func describeOnce(entry: ModelEntry, imageData: Data, mimeType: String,
                                     instruction: String) async throws -> String {
        let provider = await AIChatViewModel.makeAgentProvider(for: entry)
        // The serializers substitute a placeholder for an image the PROVIDER's model
        // record says it cannot take — the request would then "succeed" with a truthful
        // "I can't see an image". Check exactly what the serializer will consult.
        guard provider.model.capabilities.supportedModalities.contains(.imageInput) else {
            throw VisionError.allCandidatesFailed(
                "model does not accept image input (its catalog entry declares no image modality), so the image could not be sent")
        }
        let work = Task { () throws -> String in
            let messages = [AgentMessage(role: .user, parts: [
                .text(instruction),
                .imageData(data: imageData, mimeType: mimeType, linuxPath: nil),
            ])]
            let stream = try await provider.streamAgentMessage(
                messages: messages,
                systemPrompt: VisionGroupText.systemPrompt,
                tools: [],
                maxTokens: 2048,
                thinkingLevel: .off
            )
            var out = ""
            for try await event in stream {
                if case .textDelta(let delta) = event { out += delta }
                try Task.checkCancellation()
            }
            return out
        }
        let timedOut = TimeoutFlag()
        let timeout = Task {
            try await Task.sleep(nanoseconds: UInt64(perAttemptTimeout * 1_000_000_000))
            timedOut.set()
            work.cancel()
        }
        defer { timeout.cancel() }
        do {
            return try await work.value
        } catch {
            if timedOut.isSet {
                throw VisionError.allCandidatesFailed("vision model timed out after \(Int(perAttemptTimeout))s")
            }
            throw error
        }
    }

    private final class TimeoutFlag: @unchecked Sendable {
        private let lock = NSLock()
        private var value = false
        func set() { lock.lock(); value = true; lock.unlock() }
        var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
    }
}
