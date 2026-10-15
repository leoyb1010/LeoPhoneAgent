import XCTest

/// [T-model-cloud-prune] 2026-10-14:服务器去掉 Cursor 后列表 283 → 64,但删掉的 219 个只在本机归档,
/// 云端副本还在;App 重启全量拉取时整批「复活」回 200+。刷新时要同时删云端副本。
final class ModelCloudPruneTests: XCTestCase {
    private func entry(_ id: String, uuid: String? = nil, colon: String = "") -> ModelCloudPrune.EntryNames {
        .init(id: id, uuid: uuid ?? id, legacyColonKey: colon)
    }

    func testOmittedEntriesDeleteEveryCloudNameTheyMayHaveUsed() {
        let existing = [entry("inst/cursor-a", uuid: "inst/cursor-a", colon: "inst:cursor-a"),
                        entry("inst/gpt", colon: "inst:gpt")]
        let kept = [entry("inst/gpt", colon: "inst:gpt")]
        let aliases = ["9F2C-RANDOM-OLD": "inst/cursor-a", "1111-OTHER": "inst/gpt"]
        XCTAssertEqual(ModelCloudPrune.recordIds(existing: existing, kept: kept, legacyAliases: aliases),
                       ["9F2C-RANDOM-OLD", "inst/cursor-a", "inst:cursor-a"],
                       "迁移前的随机 UUID 记录名也要删,保留的模型和它的别名不动")
    }

    func testNothingOmittedMeansNoDeletes() {
        let list = [entry("a"), entry("b")]
        XCTAssertEqual(ModelCloudPrune.recordIds(existing: list, kept: list, legacyAliases: ["x": "a"]), [])
    }

    /// 条目换了 uuid 但规范 id 还在保留列表里:不算被拿掉。
    func testAnEntryKeptUnderEitherNameIsNotDeleted() {
        let existing = [entry("inst/m", uuid: "u-old")]
        let kept = [entry("inst/m", uuid: "u-new")]
        XCTAssertEqual(ModelCloudPrune.recordIds(existing: existing, kept: kept, legacyAliases: [:]), [])
    }

    /// 只在服务商自己的 /models 明确返回非空列表时删云端;退回 models.dev / 内置列表不删。
    func testOnlyAnAuthoritativeServerListPrunesTheCloud() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let store = try String(contentsOf: root.appendingPathComponent("Providers/ProviderConfigStore.swift"), encoding: .utf8)
        let fn = try XCTUnwrap(store.range(of: "func replaceEntries(for instanceId: String"))
        let body = String(store[fn.lowerBound...].prefix(2600))
        XCTAssertTrue(body.contains("pruneCloudCopies: Bool = false"), "默认不删")
        XCTAssertTrue(body.contains("let cloudDeletes = pruneCloudCopies && !rawModels.isEmpty"))
        let save = try XCTUnwrap(body.range(of: "guard save() else { return false }"))
        let push = try XCTUnwrap(body.range(of: "operation: \"delete\""))
        XCTAssertLessThan(save.lowerBound, push.lowerBound, "本机保存成功之后才推云端删除")
        XCTAssertEqual(store.components(separatedBy: "pruneCloudCopies: result.source == \"api\"").count - 1, 2,
                       "手动刷新和每日自动刷新都按来源决定")
        let detail = try String(contentsOf: root.appendingPathComponent("Views/Providers/ProviderInstanceDetailView.swift"), encoding: .utf8)
        XCTAssertTrue(detail.contains("pruneCloudCopies: result.source == \"api\""), "实例详情页的「获取模型」也一样")
        // 升级后第一次不等明天,当天就跑一次刷新把积下的云端旧副本清掉。
        XCTAssertTrue(store.contains("let pruneOnceKey = \"leo.models.cloudPruneOnce.v1\""))
        XCTAssertTrue(store.contains("            lastRefresh = nil\n"))
    }
}
