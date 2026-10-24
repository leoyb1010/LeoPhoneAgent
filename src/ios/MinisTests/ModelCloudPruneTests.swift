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

    /// 1.86:刷新(自动、手动、详情页)一律只增不删,不再推云端删除;只有「清理已下线模型」才删。
    /// 2026-10-24 实测:CLIProxyAPI 列表随上游起伏,哪台设备在低谷时刷新,别的设备刚读到的模型就被一起删掉。
    func testOnlyAnExplicitCleanUpPrunesTheCloud() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let store = try String(contentsOf: root.appendingPathComponent("Providers/ProviderConfigStore.swift"), encoding: .utf8)
        let fn = try XCTUnwrap(store.range(of: "func replaceEntries(for instanceId: String"))
        let body = String(store[fn.lowerBound...].prefix(3600))
        XCTAssertTrue(body.contains("pruneCloudCopies: Bool = false"), "默认不删")
        let save = try XCTUnwrap(body.range(of: "guard save() else { return false }"))
        let push = try XCTUnwrap(body.range(of: "operation: \"delete\""))
        XCTAssertLessThan(save.lowerBound, push.lowerBound, "本机保存成功之后才推云端删除")
        XCTAssertEqual(store.components(separatedBy: "pruneCloudCopies: true").count - 1, 1, "只有一处会删")
        let cleanUp = try XCTUnwrap(store.range(of: "func cleanUpOfflineModels(for instance: ProviderInstance)"))
        let prune = try XCTUnwrap(store.range(of: "pruneCloudCopies: true"))
        XCTAssertLessThan(cleanUp.lowerBound, prune.lowerBound, "那一处在「清理已下线模型」里")
        XCTAssertFalse(store.contains("pruneCloudCopies: result.source"), "刷新不再按来源删")
        let detail = try String(contentsOf: root.appendingPathComponent("Views/Providers/ProviderInstanceDetailView.swift"), encoding: .utf8)
        XCTAssertFalse(detail.contains("pruneCloudCopies"), "详情页的「获取模型」也只增不删")
        XCTAssertTrue(detail.contains("store.additiveModels(for: freshInstance.id"))
        XCTAssertEqual(store.components(separatedBy: "additiveModels(for: instance.id").count - 1, 2, "手动、自动刷新都走合并")
    }

    func testAdditiveMergeKeepsWhatThisDeviceDidNotSee() {
        XCTAssertEqual(ModelCloudPrune.additiveMergeIds(fresh: ["go/kimi-k3.1-pro", "grok-4.7"],
                                                        existing: ["cursor/grok-4.7-high-fast", "grok-4.7"]),
                       ["go/kimi-k3.1-pro", "grok-4.7", "cursor/grok-4.7-high-fast"],
                       "网关这次没列出 cursor/…(上游低谷):留着,不删")
        XCTAssertEqual(ModelCloudPrune.additiveMergeIds(fresh: ["claude-fable-5-dd-orp-1.3k-imik/og"],
                                                        existing: ["claude-fable-5-dd-orp-1.3k-imik/og", "go/kimi-k3.1-pro"]),
                       ["go/kimi-k3.1-pro"], "伪装 ID 还原后与真实 ID 合并成一条")
        XCTAssertEqual(ModelCloudPrune.additiveMergeIds(fresh: ["a", "b"], existing: [], excluded: ["b"]), ["a"],
                       "用户删过的不自动加回")
    }

    func testRefreshRunsEverySixHoursAndOnForeground() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let store = try String(contentsOf: root.appendingPathComponent("Providers/ProviderConfigStore.swift"), encoding: .utf8)
        XCTAssertTrue(store.contains("static let modelRefreshInterval: TimeInterval = 6 * 3600"))
        XCTAssertFalse(store.contains("calendar.isDateInToday(lastRefresh)"), "不再一天只读一次")
        let app = try String(contentsOf: root.appendingPathComponent("MinisApp.swift"), encoding: .utf8)
        let fg = try XCTUnwrap(app.range(of: "private static func runAfterForegroundFrame()"))
        XCTAssertTrue(String(app[fg.lowerBound...].prefix(4000)).contains("ProviderConfigStore.shared.refreshAllModelsIfNeeded()"),
                      "回到前台也会读")
    }

    // MARK: - 网关伪装 ID 与品牌分组(1.86)

    func testCloakedGatewayIdsAreRestored() {
        XCTAssertEqual(ModelIdentity.decodeCloaked("claude-fable-5-dd-orp-1.3k-imik/og"), "go/kimi-k3.1-pro")
        XCTAssertEqual(ModelIdentity.decodeCloaked("claude-fable-5-dd-hgih-hsalf-8.3-inimeg"), "gemini-3.8-flash-high")
        XCTAssertEqual(ModelIdentity.decodeCloaked("claude-opus-5-5-high"), "claude-opus-5-5-high")
        XCTAssertEqual(ModelIdentity.decodeCloaked("go/kimi-k3"), "go/kimi-k3")
        XCTAssertTrue(ModelIdentity.isCloaked("claude-fable-5-dd-7.4-korg"))
        XCTAssertFalse(ModelIdentity.isCloaked("claude-sonnet-4-6"))
    }

    func testEachBrandsNewestFlagshipIsLatest() {
        let ids = ["go/kimi-k2.6", "go/kimi-k3", "cn/kimi-k3-2", "go/kimi-k3.1-pro", "cn/kimi-k3.1-pro-highspeed",
                   "go/qwen3.8-flash", "go/qwen3.8-max", "go/qwen3.7-max", "grok-4.20-0309-reasoning", "grok-4.7",
                   "grok-4.7-build-fast", "gpt-oss-120b-medium", "go/gpt-5.6-luna", "go/gpt-6-luna",
                   "go/deepseek-v4-pro", "go/deepseek-v4.1-flash", "claude-opus-4-6-thinking", "claude-opus-5-5-high",
                   "cn/fast-model"]
        XCTAssertEqual(ModelBrand.latestIds(ids),
                       ["go/kimi-k3.1-pro", "go/qwen3.8-max", "grok-4.7", "go/gpt-6-luna", "go/deepseek-v4.1-flash",
                        "claude-opus-5-5-high"], "没版本号的路由别名不算")
        XCTAssertEqual(ModelBrand.family(of: "claude-fable-5-dd-orp-1.3k-imik/og"), "kimi", "伪装 ID 按真实品牌归组")
    }

    func testSectionsGroupByBrandNewestFirstAliasesLast() {
        let sections = ModelBrand.sections(["cn/fast-model", "go/kimi-k3", "go/kimi-k3.1-pro", "claude-sonnet-4-6",
                                            "claude-sonnet-5-5-high", "go/qwen3.8-max"]) { $0 }
        XCTAssertEqual(sections.map(\.family), ["claude-sonnet", "kimi", "qwen", "fast"])
        XCTAssertEqual(sections[1].items, ["go/kimi-k3.1-pro", "go/kimi-k3"])
        XCTAssertEqual(sections[0].items.first, "claude-sonnet-5-5-high")
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
        let body = String(store[fn.lowerBound...].prefix(3600))
        let save = try XCTUnwrap(body.range(of: "guard save() else { return false }"))
        let record = try XCTUnwrap(body.range(of: "ModelCloudPrune.recordServerList("))
        XCTAssertTrue(sourceContains(root, "Providers/ModelCloudPrune.swift", "\"leo.models.serverLists.v2\""),
                      "旧的自动刷新记下的残缺列表作废")
        XCTAssertLessThan(save.lowerBound, record.lowerBound)
        XCTAssertTrue(body.contains("if pruneCloudCopies && !rawModels.isEmpty {"), "只有服务商自己的列表才记")

        let sync = try String(contentsOf: root.appendingPathComponent("Agent/Sync/V2/ChatStoreSyncHydrators.swift"), encoding: .utf8)
        let merge = try XCTUnwrap(sync.range(of: "private static func mergeProviderModelEntryV3"))
        let mergeBody = String(sync[merge.lowerBound...].prefix(6000))
        let check = try XCTUnwrap(mergeBody.range(of: "ModelCloudPrune.rejectsInbound("))
        let upsert = try XCTUnwrap(mergeBody.range(of: "db.upsertEntryFromInbound("))
        XCTAssertLessThan(check.lowerBound, upsert.lowerBound, "先判再写")
        XCTAssertTrue(mergeBody.contains("for name in Set([rawId, id])"), "云端记录名两种形式都删")
        let cloaked = try XCTUnwrap(mergeBody.range(of: "ModelIdentity.isCloaked(m)"))
        XCTAssertLessThan(cloaked.lowerBound, upsert.lowerBound, "伪装 ID 的旧记录不再写进本机")
    }

    private func sourceContains(_ root: URL, _ path: String, _ needle: String) -> Bool {
        (try? String(contentsOf: root.appendingPathComponent(path), encoding: .utf8))?.contains(needle) ?? false
    }
}
