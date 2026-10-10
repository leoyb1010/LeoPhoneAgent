import XCTest

/// [B24] Sub-agent children run in the background pool and are released when
/// they finish, so they can never push the user's own chats out of the cache.
final class ViewModelCachePolicyTests: XCTestCase {

    func testChildSessionsNeverEvictUserChats() {
        let user = (1...6).map { "user-\($0)" }
        let children = (1...12).map { "child-\($0)" }
        // Children opened after the user's chats (most recently used).
        let lru = user + children
        let pools = Dictionary(uniqueKeysWithValues: user.map { ($0, ViewModelCachePool.normal) }
            + children.map { ($0, ViewModelCachePool.background) })
        let victims = ViewModelCachePolicy.victims(lruOrder: lru, pool: { pools[$0] ?? .normal },
                                                   isEvictable: { _ in true })
        XCTAssertTrue(victims.allSatisfy { $0.hasPrefix("child-") }, "no user chat is evicted: \(victims)")
        XCTAssertEqual(victims, ["child-1", "child-2"], "the background pool trims its own oldest entries to its cap")
    }

    func testChildrenInTheNormalPoolWouldHaveEvictedUserChats() {
        // The pre-fix behaviour: children created with the default pool.
        let lru = (1...6).map { "user-\($0)" } + (1...3).map { "child-\($0)" }
        let victims = ViewModelCachePolicy.victims(lruOrder: lru, pool: { _ in .normal }, isEvictable: { _ in true })
        XCTAssertEqual(victims, ["user-1", "user-2", "user-3"])
    }

    func testRunningOrVisibleEntriesAreSkipped() {
        let lru = (1...8).map { "s\($0)" }
        let victims = ViewModelCachePolicy.victims(lruOrder: lru, pool: { _ in .normal },
                                                   isEvictable: { $0 != "s1" })
        XCTAssertEqual(victims, ["s2", "s3"], "a busy oldest entry is skipped, the next ones go")
        XCTAssertEqual(ViewModelCachePolicy.cap(for: .normal), 6)
        XCTAssertEqual(ViewModelCachePolicy.cap(for: .background), 10)
    }

    func testSubAgentWiring() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        func read(_ path: String) throws -> String {
            try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
        }
        let runner = try read("Agent/Jobs/HelperRunner.swift")
        XCTAssertTrue(runner.contains("ViewModelCache.shared.getOrCreate(for: childId, kind: .background)"))
        XCTAssertFalse(runner.contains("Task.sleep(nanoseconds: 500_000_000)"), "no 500 ms poll loop")
        XCTAssertTrue(runner.contains("await Self.awaitSubAgentChange(child, parent: self, upTo: 1.0)"))
        let registry = try read("Agent/Jobs/AgentJobRegistry.swift")
        guard let finish = registry.range(of: "func finish("),
              let cancel = registry.range(of: "func cancel(jobId:") else { return XCTFail("finish not found") }
        let body = registry[finish.lowerBound..<cancel.lowerBound]
        XCTAssertTrue(body.contains("ViewModelCache.shared.releaseIfIdle(sessionId: sid, reason: \"sub agent finished\")"))
        let hook = try XCTUnwrap(body.range(of: "job.completionHook?(job)"))
        let release = try XCTUnwrap(body.range(of: "releaseIfIdle"))
        XCTAssertLessThan(hook.lowerBound, release.lowerBound, "released only after the result is written")
        let cache = try read("Agent/Chat/ChatLifecycleSupport.swift")
        XCTAssertTrue(cache.contains("guard let vm = cache[sessionId], isEvictable(sessionId, vm) else { return false }"),
                      "release obeys the same guard as eviction (never a running or visible VM)")
    }
}
