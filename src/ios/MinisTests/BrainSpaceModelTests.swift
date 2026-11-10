//
//  BrainSpaceModelTests.swift
//  MinisTests
//
//  [brain-space] 第二大脑空间的数据契约:用合成样例(不含真实资料)锁住资料库 /api 的形状,
//  尤其是曾经解析失败的字段(place_guess 是对象、who 是数组、尺寸是整数、OCR 状态里的 job 是对象)。
//

import XCTest

final class BrainSpaceModelTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try BrainSpaceJSON.decoder.decode(T.self, from: Data(json.utf8))
    }

    func testMediaDetailAcceptsObjectPlaceGuessAndPeople() throws {
        let d = try decode(BrainMediaDetail.self, """
        {"id":"aaaaaaaaaaaaaaaaaaaaaaaa","media_kind":"video","captured_at":"2026-11-02T19:41:19+08:00","place":"",
         "place_guess":{"place":"示例城市 · 示例小区","basis":"同一来源前后3小时","guess":true},
         "ai":{"description":"示例描述","tags":["a","b"]},"who":[{"id":"x","name":"甲","evidence":"auto"}],
         "width":1920,"height":1080,"duration":153.8,"caption":"自动识别","backup_status":"external_original"}
        """)
        XCTAssertTrue(d.isVideo)
        XCTAssertEqual(d.placeGuess?.place, "示例城市 · 示例小区")
        XCTAssertEqual(d.who?.first?.name, "甲")
        XCTAssertEqual(d.width, 1920)
    }

    func testOcrStatusIgnoresJobObject() throws {
        let o = try decode(BrainOCRStatus.self, """
        {"sha256":"ab","required_pages":[1,2,3],"completed_pages":[1,2],"failed_pages":[],"pending_pages":[3],
         "applied":true,"job":{"id":"j","state":"running"},"available":true,"error":null}
        """)
        XCTAssertEqual(o.pendingPages, [3])
    }

    func testUploadReceiptAndChunkReply() throws {
        let s = try decode(BrainUploadState.self, """
        {"id":"bbbbbbbbbbbbbbbbbbbbbbbb","name":"x.jpg","size":4127524,"received":4127524,"chunk":8388608,"state":"received",
         "receipt":{"restricted":false,"name":"x.jpg","file_id":"cccccccccccccccccccccccc","integrity":{"method":"client_chunk_sha256"}}}
        """)
        XCTAssertEqual(s.receipt?.fileId, "cccccccccccccccccccccccc")
        XCTAssertEqual(try decode(BrainUploadState.Chunk.self, #"{"received":8388608,"resync":true}"#).received, 8388608)
    }

    func testAnswerSourcesAndShareResult() throws {
        let a = try decode(BrainArchiveAnswer.self, """
        {"id":"dd","status":"completed","result":{"answer":"### 结论\\n* 一","sources":[{"number":3,"file_id":"ee","title":"t","locator":"第2页"}],"model_used":true}}
        """)
        XCTAssertEqual(a.result?.sources?.first?.number, 3)
        let r = try decode(BrainShareResult.self, #"{"token":"tok123456789","path":"/s/tok123456789","expires_at":"2026-11-10T00:00:00+08:00","count":2}"#)
        XCTAssertEqual(r.id, r.token)
    }

    func testNiceNameHidesPhotoLibraryCodes() {
        XCTAssertEqual(BrainFormat.niceName("分享「DFAAC949-FAEC-4699-B1A4-69A0D7F98F60.heic」给家人"), "分享「一张照片」给家人")
        XCTAssertEqual(BrainFormat.niceName("2FACFA48-C661-4EC2-BA50-ADD754E37638.mp4"), "一段视频")
        XCTAssertEqual(BrainFormat.niceName("报告.pdf"), "报告.pdf")
    }
}

// MARK: - BrainSearchModel lifecycle (actual production model, controlled loader order)

private struct SearchFixtureError: LocalizedError {
    var errorDescription: String? { "合成网络错误" }
}

/// Holds every loader / debounce call until the test resumes it, so response order is chosen by the test.
@MainActor
private final class SearchGate {
    struct Call { let query: String; let continuation: CheckedContinuation<BrainSearchPage, Error> }
    var calls: [Call] = []
    var pauses: [CheckedContinuation<Void, Error>] = []
    var resumed = Set<Int>()

    func load(_ q: String) async throws -> BrainSearchPage {
        try await withCheckedThrowingContinuation { calls.append(Call(query: q, continuation: $0)) }
    }

    func pause() async throws {
        try await withCheckedThrowingContinuation { pauses.append($0) }
    }

    func succeed(_ index: Int, ids: [String], line: UInt = #line) {
        guard calls.indices.contains(index) else { return XCTFail("loader call \(index) was never made", line: line) }
        resumed.insert(index)
        calls[index].continuation.resume(returning: BrainSearchPage(items: ids.map { BrainSearchPage.Item(id: $0) }, total: ids.count))
    }

    func fail(_ index: Int, _ error: Error = SearchFixtureError(), line: UInt = #line) {
        guard calls.indices.contains(index) else { return XCTFail("loader call \(index) was never made", line: line) }
        resumed.insert(index)
        calls[index].continuation.resume(throwing: error)
    }

    /// Release anything still suspended so no continuation leaks past the test.
    func drain() {
        for i in calls.indices where !resumed.contains(i) { fail(i, CancellationError()) }
        pauses.forEach { $0.resume() }
        pauses = []
    }
}

@MainActor
final class BrainSearchModelTests: XCTestCase {
    private var gate: SearchGate!

    /// Debounce is a controllable pause unless `immediatePause`.
    private func makeModel(immediatePause: Bool = true) -> BrainSearchModel {
        let gate = SearchGate()
        self.gate = gate
        addTeardownBlock { @MainActor in gate.drain() }
        let pause: BrainSearchModel.Pause
        if immediatePause { pause = {} } else { pause = { try await gate.pause() } }
        return BrainSearchModel(load: { try await gate.load($0) }, pause: pause)
    }

    /// Let model tasks run up to their next suspension point.
    private func settle() async { for _ in 0..<40 { await Task.yield() } }

    private func ids(_ m: BrainSearchModel) -> [String] { m.results.map(\.id) }

    func testLaterRequestWinsWhenOlderArrivesLast() async {
        let m = makeModel()
        m.appear(revision: 1)
        m.query = "A"; m.submit(); await settle()
        m.query = "B"; m.submit(); await settle()
        XCTAssertEqual(gate.calls.map(\.query), ["A", "B"])
        gate.succeed(1, ids: ["b"]); await settle()
        XCTAssertEqual(ids(m), ["b"]); XCTAssertFalse(m.searching)
        gate.succeed(0, ids: ["a"]); await settle()
        XCTAssertEqual(ids(m), ["b"], "stale A must not overwrite B")
        XCTAssertFalse(m.searching); XCTAssertNil(m.error)
    }

    func testOlderFailureNeverTouchesNewerSuccessOrLoading() async {
        let m = makeModel()
        m.appear(revision: 1)
        m.query = "A"; m.submit(); await settle()
        m.query = "B"; m.submit(); await settle()
        gate.fail(0); await settle()
        XCTAssertNil(m.error, "stale A failure must not show")
        XCTAssertTrue(m.searching, "stale A must not end B's loading")
        gate.succeed(1, ids: ["b"]); await settle()
        XCTAssertEqual(ids(m), ["b"]); XCTAssertFalse(m.searching); XCTAssertNil(m.error)
    }

    func testABAWithFirstALate() async {
        let m = makeModel()
        m.appear(revision: 1)
        m.query = "A"; m.submit(); await settle()
        m.query = "B"; m.submit(); await settle()
        m.query = "A"; m.submit(); await settle()
        XCTAssertEqual(gate.calls.map(\.query), ["A", "B", "A"])
        gate.succeed(0, ids: ["a1"]); await settle()
        XCTAssertEqual(ids(m), [], "A1 has the same text as A2 but is an older request")
        XCTAssertTrue(m.searching)
        gate.succeed(2, ids: ["a2"]); await settle()
        gate.succeed(1, ids: ["b"]); await settle()
        XCTAssertEqual(ids(m), ["a2"]); XCTAssertFalse(m.searching)
    }

    func testTypingDebouncesAndSubmitSupersedesPendingDebounce() async {
        let m = makeModel(immediatePause: false)
        m.appear(revision: 1)
        m.query = "A"; await settle()
        XCTAssertEqual(gate.pauses.count, 1); XCTAssertTrue(gate.calls.isEmpty, "typing waits for the debounce")
        XCTAssertTrue(m.searching)
        m.query = "A "; await settle()
        XCTAssertEqual(gate.pauses.count, 1, "whitespace-only edits do not restart")
        m.submit(); await settle()
        XCTAssertEqual(gate.calls.map(\.query), ["A"], "submit is immediate")
        gate.pauses.forEach { $0.resume() }; gate.pauses = []; await settle()
        XCTAssertEqual(gate.calls.count, 1, "the superseded debounce must not fire a second request")
        gate.succeed(0, ids: ["a"]); await settle()
        XCTAssertEqual(ids(m), ["a"]); XCTAssertFalse(m.searching)
    }

    func testRepeatedSubmitKeepsOnlyLastAndClearDropsEverything() async {
        let m = makeModel()
        m.appear(revision: 1)
        m.query = "A"; m.submit(); await settle()
        m.submit(); await settle()
        XCTAssertEqual(gate.calls.count, 2)
        gate.succeed(1, ids: ["second"]); await settle()
        gate.succeed(0, ids: ["first"]); await settle()
        XCTAssertEqual(ids(m), ["second"])

        m.submit(); await settle()          // retry same keyword keeps current results while loading
        XCTAssertEqual(ids(m), ["second"]); XCTAssertTrue(m.searching)
        m.query = ""; await settle()
        XCTAssertEqual(ids(m), []); XCTAssertFalse(m.searching); XCTAssertNil(m.error)
        gate.succeed(2, ids: ["late"]); await settle()
        XCTAssertEqual(ids(m), [], "a cleared box stays empty")
        XCTAssertEqual(gate.calls.count, 3, "clearing never issues a search")
    }

    func testErrorThenRetrySucceeds() async {
        let m = makeModel()
        m.appear(revision: 1)
        m.query = "A"; m.submit(); await settle()
        gate.fail(0); await settle()
        XCTAssertEqual(m.error, "合成网络错误"); XCTAssertFalse(m.searching)
        m.submit(); await settle()
        XCTAssertNil(m.error); XCTAssertTrue(m.searching)
        gate.succeed(1, ids: ["a"]); await settle()
        XCTAssertEqual(ids(m), ["a"]); XCTAssertNil(m.error)
    }

    func testDirectCancellationClosesOwnLoadingWithoutError() async {
        let m = makeModel()
        m.appear(revision: 1)
        m.query = "A"; m.submit(); await settle()
        gate.fail(0, CancellationError()); await settle()
        XCTAssertFalse(m.searching, "the current request's own cancellation must end loading")
        XCTAssertNil(m.error, "cancellation is not a network error")
    }

    func testHiddenRevisionChangeThenLateResponseThenReappearSearchesOnce() async {
        let m = makeModel()
        m.appear(revision: 1)
        m.query = "A"; m.submit(); await settle()
        gate.succeed(0, ids: ["old"]); await settle()
        m.submit(); await settle()                       // in flight on revision 1
        m.disappear()
        XCTAssertFalse(m.searching)
        m.connectionChanged(to: 2); await settle()
        XCTAssertEqual(gate.calls.count, 2, "a hidden page never starts a search")
        XCTAssertEqual(ids(m), [], "old-connection results are invalid at once")
        gate.succeed(1, ids: ["late-old"]); await settle()
        XCTAssertEqual(ids(m), []); XCTAssertFalse(m.searching)
        m.appear(revision: 2); await settle()
        XCTAssertEqual(gate.calls.count, 3, "reappearing on a new revision searches exactly once")
        gate.succeed(2, ids: ["new"]); await settle()
        XCTAssertEqual(ids(m), ["new"])
        m.disappear(); m.appear(revision: 2); await settle()
        XCTAssertEqual(gate.calls.count, 3, "results already match query and revision: no extra request")
    }

    func testReappearCatchesRevisionChangeMissedWhileHidden() async {
        let m = makeModel()
        m.appear(revision: 1)
        m.query = "A"; m.submit(); await settle()
        gate.succeed(0, ids: ["r1"]); await settle()
        m.disappear()
        m.appear(revision: 5); await settle()            // onChange never delivered while hidden
        XCTAssertEqual(ids(m), [], "results from revision 1 are not shown under revision 5")
        XCTAssertEqual(gate.calls.count, 2)
        gate.succeed(1, ids: ["r5"]); await settle()
        XCTAssertEqual(ids(m), ["r5"])
    }

    func testVisibleConnectionSwitchClearsOldResultsAndDropsOldResponse() async {
        let m = makeModel()
        m.appear(revision: 1)
        m.query = "A"; m.submit(); await settle()
        gate.succeed(0, ids: ["r1"]); await settle()
        m.submit(); await settle()                       // revision-1 request still in flight
        m.connectionChanged(to: 2); await settle()
        XCTAssertEqual(ids(m), []); XCTAssertTrue(m.searching)
        XCTAssertEqual(gate.calls.count, 3, "visible page re-searches once on the new connection")
        gate.succeed(1, ids: ["late-r1"]); await settle()
        XCTAssertEqual(ids(m), []); XCTAssertTrue(m.searching, "old-connection reply cannot end new loading")
        gate.succeed(2, ids: ["r2"]); await settle()
        XCTAssertEqual(ids(m), ["r2"]); XCTAssertFalse(m.searching)
        m.connectionChanged(to: 2); await settle()
        XCTAssertEqual(gate.calls.count, 3, "same revision is a no-op")
    }

    func testSubmitWhileHiddenDoesNothing() async {
        let m = makeModel()
        m.appear(revision: 1)
        m.query = "A"; m.submit(); await settle()
        gate.succeed(0, ids: ["a"]); await settle()
        m.disappear()
        m.submit()
        XCTAssertFalse(m.searching, "a hidden page does not even show loading")
        await settle()
        XCTAssertEqual(gate.calls.count, 1, "a hidden page never starts a search")
        XCTAssertFalse(m.searching)
    }

    func testTypingWhileHiddenDefersToReappear() async {
        let m = makeModel()
        m.appear(revision: 1)
        m.disappear()
        m.query = "A"; await settle()
        XCTAssertTrue(gate.calls.isEmpty); XCTAssertFalse(m.searching)
        m.appear(revision: 1); await settle()
        XCTAssertEqual(gate.calls.map(\.query), ["A"])
    }
}
