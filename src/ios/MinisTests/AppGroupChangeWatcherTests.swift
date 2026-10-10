import XCTest

/// [S2] Watch selection: roots reserved first, skills shallow, junk skipped,
/// the walk stops at the cap and reports one summary line per root.
final class AppGroupChangeWatcherTests: XCTestCase {
    private var tmp: URL!

    override func setUpWithError() throws {
        tmp = FileManager.default.temporaryDirectory.appendingPathComponent("fpwatch-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmp)
    }

    private func mkdir(_ rel: String) throws {
        try FileManager.default.createDirectory(at: tmp.appendingPathComponent(rel), withIntermediateDirectories: true)
    }

    private var roots: [AppGroupWatchPlanner.Root] {
        ["shared", "skills", "memory"].map { .init(key: $0, url: tmp.appendingPathComponent($0)) }
    }

    private func plan(cap: Int = 180) -> AppGroupWatchPlanner.Plan {
        AppGroupWatchPlanner.plan(roots: roots, cap: cap,
                                  listSubdirectories: AppGroupWatchPlanner.fileSystemSubdirectories)
    }

    /// The device case: one skill with a 2000-directory resource tree.
    func testWatcher_capReached_logsOnce() throws {
        for root in ["shared", "skills", "memory"] { try mkdir(root) }
        for i in 0..<2000 { try mkdir("skills/wechatpay-payment-integration/assets/d\(i)") }
        for i in 0..<400 { try mkdir("shared/big/d\(i)") }
        var listed = 0
        let p = AppGroupWatchPlanner.plan(roots: roots, cap: 180) { url in
            listed += 1
            return AppGroupWatchPlanner.fileSystemSubdirectories(of: url)
        }
        XCTAssertEqual(p.entries.count, 180)
        XCTAssertTrue(p.capReached)
        XCTAssertEqual(p.summaryLines.count, 3, "exactly one line per root, never one per skipped dir")
        XCTAssertTrue(p.summaryLines[0].contains("root=shared"))
        XCTAssertTrue(p.summaryLines[2].contains("root=memory"))
        XCTAssertTrue(p.summaryLines.allSatisfy { $0.contains("capReached=true") })
        // skills is depth ≤ 1: the 2000-dir asset tree is never even listed.
        XCTAssertFalse(p.entries.contains { $0.rootKey == "skills" && $0.depth > 1 })
        XCTAssertLessThan(listed, 10, "the walk stops listing at the cap")
    }

    func testWatcher_reservesRootWatches() throws {
        for root in ["shared", "skills", "memory"] { try mkdir(root) }
        for i in 0..<300 { try mkdir("shared/s\(i)/inner") }
        for i in 0..<60 { try mkdir("skills/skill\(i)/scripts/deep") }
        try mkdir("memory/2026")
        let p = plan()
        let keys = Set(p.entries.filter { $0.relativePath.isEmpty }.map(\.rootKey))
        XCTAssertEqual(keys, ["shared", "skills", "memory"], "every root gets a watch")
        XCTAssertTrue(p.entries.contains { $0.rootKey == "memory" && $0.relativePath == "2026" },
                      "memory's top level is reserved before shared's deep tree")
        XCTAssertGreaterThan(p.stats["skills"]?.attached ?? 0, 50, "round-robin: skills is not starved by shared")
        XCTAssertEqual(p.entries.count, 180)
    }

    func testWatcher_skipsDependencyAndBuildDirectories() throws {
        try mkdir("shared/project/node_modules/pkg")
        try mkdir("shared/project/dist")
        try mkdir("shared/project/src")
        try mkdir("shared/__pycache__")
        try mkdir("shared/venv/lib")
        try mkdir("skills/a/build")
        try mkdir("memory")
        let p = plan()
        let rels = Set(p.entries.map { "\($0.rootKey)/\($0.relativePath)" })
        XCTAssertTrue(rels.contains("shared/project/src"))
        for junk in ["shared/project/node_modules", "shared/project/dist", "shared/__pycache__", "shared/venv", "skills/a/build"] {
            XCTAssertFalse(rels.contains(junk), junk)
        }
        XCTAssertFalse(p.capReached)
        XCTAssertEqual(p.stats["shared"]?.excluded, 4)
    }

    func testWatcher_runtimeAdmissionRules() {
        XCTAssertTrue(AppGroupWatchPlanner.shouldWatch(name: "new-skill", parentDepth: 0, rootKey: "skills"))
        XCTAssertFalse(AppGroupWatchPlanner.shouldWatch(name: "assets", parentDepth: 1, rootKey: "skills"))
        XCTAssertTrue(AppGroupWatchPlanner.shouldWatch(name: "deep", parentDepth: 5, rootKey: "shared"))
        XCTAssertFalse(AppGroupWatchPlanner.shouldWatch(name: "node_modules", parentDepth: 0, rootKey: "shared"))
    }

    func testWatcherIsQueueOwnedAndForegroundThrottled() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let text = try String(contentsOf: root.appendingPathComponent("FileProvider/AppGroupChangeWatcher.swift"), encoding: .utf8)
        XCTAssertFalse(text.contains("@MainActor\nfinal class AppGroupChangeWatcher"))
        XCTAssertTrue(text.contains("foregroundReconcileInterval: TimeInterval = 60"))
        XCTAssertFalse(text.contains("skipping \\(url.path)"), "no per-directory WARN")
    }
}
