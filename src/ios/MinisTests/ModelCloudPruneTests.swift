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
        let body = String(store[fn.lowerBound...].prefix(3200))
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
        XCTAssertTrue(store.contains("let pruneOnceKey = \"leo.models.cloudPruneOnce.v2\""))
        XCTAssertTrue(store.contains("            lastRefresh = nil\n"))
    }

    // MARK: - 拒收云端旧副本(1.74)

    func testStaleCloudCopyOfAModelTheServerDroppedIsRejected() {
        let list = ModelCloudPrune.ServerList(at: Date(timeIntervalSince1970: 2_000), modelIds: ["gpt-5", "go/k2"])
        let old = Date(timeIntervalSince1970: 1_000), newer = Date(timeIntervalSince1970: 3_000)
        XCTAssertTrue(ModelCloudPrune.rejectsInbound(modelId: "cursor/gpt-5", isCustom: false, updatedAt: old, serverList: list),
                      "服务器列表里没有、又比列表旧:旧副本")
        XCTAssertFalse(ModelCloudPrune.rejectsInbound(modelId: "gpt-5", isCustom: false, updatedAt: old, serverList: list),
                       "服务器还在提供的照收")
        XCTAssertFalse(ModelCloudPrune.rejectsInbound(modelId: "cursor/x", isCustom: true, updatedAt: old, serverList: list),
                       "用户手动加的自定义模型永远不拒")
        XCTAssertFalse(ModelCloudPrune.rejectsInbound(modelId: "new-model", isCustom: false, updatedAt: newer, serverList: list),
                       "比本机列表新:别的设备刚刷到的新模型,放行")
        XCTAssertFalse(ModelCloudPrune.rejectsInbound(modelId: "cursor/x", isCustom: false, updatedAt: old, serverList: nil),
                       "还没刷过这个服务商:没有依据,不拒")
        XCTAssertFalse(ModelCloudPrune.rejectsInbound(modelId: "cursor/x", isCustom: false, updatedAt: old,
                                                      serverList: .init(at: list.at, modelIds: [])), "空列表不算数")
    }

    func testServerListIsStoredPerInstance() throws {
        let suite = "ModelCloudPruneTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let a = ModelCloudPrune.ServerList(at: Date(timeIntervalSince1970: 10), modelIds: ["m1"])
        let b = ModelCloudPrune.ServerList(at: Date(timeIntervalSince1970: 20), modelIds: ["m2", "m3"])
        ModelCloudPrune.recordServerList(a, for: "inst-a", defaults: defaults)
        ModelCloudPrune.recordServerList(b, for: "inst-b", defaults: defaults)
        XCTAssertEqual(ModelCloudPrune.serverList(for: "inst-a", defaults: defaults), a)
        XCTAssertEqual(ModelCloudPrune.serverList(for: "inst-b", defaults: defaults), b)
        XCTAssertNil(ModelCloudPrune.serverList(for: "inst-c", defaults: defaults))
    }

    /// 接线:API 刷新成功后记列表;iCloud 合并在写库之前先判旧副本,拒收时删云端。
    func testRefreshRecordsTheListAndTheMergerChecksItBeforeWriting() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let store = try String(contentsOf: root.appendingPathComponent("Providers/ProviderConfigStore.swift"), encoding: .utf8)
        let fn = try XCTUnwrap(store.range(of: "func replaceEntries(for instanceId: String"))
        let body = String(store[fn.lowerBound...].prefix(3200))
        let save = try XCTUnwrap(body.range(of: "guard save() else { return false }"))
        let record = try XCTUnwrap(body.range(of: "ModelCloudPrune.recordServerList("))
        XCTAssertLessThan(save.lowerBound, record.lowerBound)
        XCTAssertTrue(body.contains("if pruneCloudCopies && !rawModels.isEmpty {"), "只有服务商自己的列表才记")

        let sync = try String(contentsOf: root.appendingPathComponent("Agent/Sync/V2/ChatStoreSyncHydrators.swift"), encoding: .utf8)
        let merge = try XCTUnwrap(sync.range(of: "private static func mergeProviderModelEntryV3"))
        let mergeBody = String(sync[merge.lowerBound...].prefix(6000))
        let check = try XCTUnwrap(mergeBody.range(of: "ModelCloudPrune.rejectsInbound("))
        let upsert = try XCTUnwrap(mergeBody.range(of: "db.upsertEntryFromInbound("))
        XCTAssertLessThan(check.lowerBound, upsert.lowerBound, "先判再写")
        XCTAssertTrue(mergeBody.contains("for name in Set([rawId, id])"), "云端记录名两种形式都删")
    }
}
