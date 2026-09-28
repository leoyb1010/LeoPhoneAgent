import Foundation

@main
enum SyncRetryPolicySmoke {
    static func main() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        var policy = SyncRetryPolicy()
        policy.failed(.query("SkillV2"), at: now, jitter: 0)
        expect(!policy.isEligible(.query("SkillV2"), at: now), "failed query backs off")
        expect(policy.isEligible(.query("MessageV2"), at: now), "unrelated query remains available")
        expect(policy.isEligible(.send, at: now), "missing type must not block upload")
        expect(policy.serviceNotBefore == nil, "local query failure is not service throttling")

        policy.failed(.changes, at: now, jitter: 0)
        expect(policy.isEligible(.send, at: now), "token fetch failure must not block upload")
        expect(policy.isEligible(.query("MessageV2"), at: now), "token fetch failure must not block queries")

        policy.observeServiceRetry(after: 300, at: now)
        policy.succeeded(.query("SkillV2"))
        expect(!policy.isEligible(.send, at: now.addingTimeInterval(299)), "success cannot erase service floor")
        expect(!policy.isEligible(.query("MessageV2"), at: now), "service floor gates healthy queries")
        expect(policy.isEligible(.send, at: now.addingTimeInterval(300)), "expired server deadline allows upload")

        var sending = SyncRetryPolicy()
        sending.failed(.send, at: now, minimumDelay: 60, jitter: 0)
        expect(sending.deadline(for: .send) == now.addingTimeInterval(60), "per-record retry hint is a floor")
        expect(sending.isEligible(.query("MessageV2"), at: now), "send backoff is isolated")
        sending.succeeded(.send)
        expect(sending.isEligible(.send, at: now), "successful send clears its local failure")

        var repeated = SyncRetryPolicy()
        for _ in 0..<100 { repeated.failed(.send, at: now, jitter: 0) }
        expect(repeated.deadline(for: .send) == now.addingTimeInterval(300), "send retry is bounded")
        repeated.failed(.query("SkillV2"), at: now, jitter: 0)
        repeated.succeeded(.send)
        expect(!repeated.isEligible(.query("SkillV2"), at: now), "send recovery does not clear failed type")

        let restored = try JSONDecoder().decode(SyncRetryPolicy.self, from: JSONEncoder().encode(policy))
        expect(!restored.isEligible(.send, at: now), "restart preserves service gate")
        let localRestored = try JSONDecoder().decode(SyncRetryPolicy.self, from: JSONEncoder().encode(repeated))
        expect(!localRestored.isEligible(.query("SkillV2"), at: now), "restart preserves query gate")

        var invalid = SyncRetryPolicy()
        invalid.observeServiceRetry(after: .nan, at: now)
        invalid.observeServiceRetry(after: -10, at: now)
        expect(invalid.serviceNotBefore == nil, "invalid hints must not poison scheduler")
        print("SyncRetryPolicySmoke: isolation, server floors, recovery, bounds and persistence passed")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fatalError(message) }
    }
}
