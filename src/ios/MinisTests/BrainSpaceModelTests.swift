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

// MARK: - BrainReaderModel lifecycle (actual production model, controlled loader order)

/// Every reader loader call parks on a continuation; the test decides order and outcome.
@MainActor
private final class ReaderGate {
    enum Kind: String { case info, provenance, ocr, chunks }
    final class Call {
        let kind: Kind; let doc: String; let offset: Int
        /// The reply stays on the main actor; only a Void wake-up crosses the continuation.
        var value: Any?
        var resume: ((Result<Void, Error>) -> Void)?
        init(kind: Kind, doc: String, offset: Int) { self.kind = kind; self.doc = doc; self.offset = offset }
    }
    var calls: [Call] = []
    var factoryCount = 0
    var factoryError: Error?

    private func park<T>(_ kind: Kind, _ doc: String, _ offset: Int = 0) async throws -> T {
        let call = Call(kind: kind, doc: doc, offset: offset)
        calls.append(call)
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            call.resume = { result in c.resume(with: result) }
        }
        return call.value as! T
    }

    func loaders() throws -> BrainReaderModel.Loaders {
        factoryCount += 1
        if let factoryError { throw factoryError }
        return BrainReaderModel.Loaders(
            info: { [unowned self] id in try await self.park(.info, id) },
            provenance: { [unowned self] id in try await self.park(.provenance, id) },
            ocr: { [unowned self] id in try await self.park(.ocr, id) },
            chunks: { [unowned self] id, offset in try await self.park(.chunks, id, offset) })
    }

    func pending(_ kind: Kind, doc: String? = nil, offset: Int? = nil) -> [Call] {
        calls.filter { $0.kind == kind && $0.resume != nil && (doc == nil || $0.doc == doc) && (offset == nil || $0.offset == offset) }
    }

    func count(_ kind: Kind) -> Int { calls.filter { $0.kind == kind }.count }

    private func finish(_ call: Call?, _ result: Result<Void, Error>, value: Any? = nil, line: UInt) {
        guard let call, let resume = call.resume else { return XCTFail("no pending loader call", line: line) }
        call.resume = nil
        call.value = value
        resume(result)
    }

    func reply(_ kind: Kind, doc: String? = nil, offset: Int? = nil, _ value: Any, line: UInt = #line) {
        finish(pending(kind, doc: doc, offset: offset).first, .success(()), value: value, line: line)
    }

    func fail(_ kind: Kind, doc: String? = nil, offset: Int? = nil, _ error: Error = SearchFixtureError(), line: UInt = #line) {
        finish(pending(kind, doc: doc, offset: offset).first, .failure(error), line: line)
    }

    func drain() {
        for call in calls { if let r = call.resume { call.resume = nil; r(.failure(CancellationError())) } }
    }
}

@MainActor
final class BrainReaderModelTests: XCTestCase {
    private var gate: ReaderGate!

    private func makeModel() -> BrainReaderModel {
        let gate = ReaderGate()
        self.gate = gate
        addTeardownBlock { @MainActor in gate.drain() }
        return BrainReaderModel(makeLoaders: { try gate.loaders() })
    }

    private func settle() async { for _ in 0..<60 { await Task.yield() } }

    private func page(_ ids: [String], total: Int) -> BrainChunkPage {
        let items = ids.map { #"{"id":"\#($0)","text":"段落 \#($0)"}"# }.joined(separator: ",")
        return try! JSONDecoder().decode(BrainChunkPage.self, from: Data(#"{"chunks":[\#(items)],"total":\#(total)}"#.utf8))
    }
    private func info(_ title: String) -> BrainFileInfo {
        try! BrainSpaceJSON.decoder.decode(BrainFileInfo.self, from: Data(#"{"id":"f","title":"\#(title)","sha256":"ab"}"#.utf8))
    }
    private func ocr(pending: [Int]) -> BrainOCRStatus {
        try! BrainSpaceJSON.decoder.decode(BrainOCRStatus.self, from: Data(#"{"sha256":"ab","required_pages":[1,2,3],"pending_pages":\#(pending)}"#.utf8))
    }
    private var provenance: BrainProvenance {
        try! BrainSpaceJSON.decoder.decode(BrainProvenance.self, from: Data(#"{"locations":[{"id":"l","role":"original"}]}"#.utf8))
    }
    private func ids(_ m: BrainReaderModel) -> [String] { m.chunks.map(\.id) }

    func testAllFourReadsStartTogetherAndBodyIsReadableBeforeSlowOCR() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        XCTAssertEqual(Set(gate.calls.map(\.kind)), [.info, .provenance, .ocr, .chunks], "metadata and first body page are concurrent")
        XCTAssertTrue(m.bodyLoading)
        gate.reply(.chunks, page(["c1", "c2"], total: 5)); await settle()
        XCTAssertEqual(ids(m), ["c1", "c2"], "body is shown while provenance / OCR are still pending")
        XCTAssertFalse(m.bodyLoading); XCTAssertTrue(m.hasMore)
        XCTAssertNil(m.ocr); XCTAssertNil(m.info)
        gate.fail(.ocr); gate.fail(.provenance); await settle()
        XCTAssertEqual(ids(m), ["c1", "c2"], "optional metadata failure never drops body")
        XCTAssertNil(m.bodyError)
    }

    func testMetadataFailureKeepsBodyAndRetryOnlyRefetchesMissing() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        gate.reply(.chunks, page(["c1"], total: 1))
        gate.fail(.info)
        gate.reply(.provenance, provenance)
        gate.reply(.ocr, ocr(pending: [3])); await settle()
        XCTAssertEqual(ids(m), ["c1"]); XCTAssertNotNil(m.infoError)
        XCTAssertEqual(m.pickedPages, [3])
        m.retry(); await settle()
        XCTAssertEqual(gate.count(.chunks), 1, "body already shown is not re-read")
        XCTAssertEqual(gate.count(.info), 2)
        XCTAssertEqual(gate.count(.ocr), 1); XCTAssertEqual(gate.count(.provenance), 1)
        gate.reply(.info, info("标题")); await settle()
        XCTAssertEqual(m.info?.title, "标题"); XCTAssertNil(m.infoError); XCTAssertEqual(ids(m), ["c1"])
    }

    func testBodyFailureIsRetryableAndClosesLoading() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        gate.fail(.chunks); await settle()
        XCTAssertFalse(m.bodyLoading); XCTAssertNotNil(m.bodyError); XCTAssertFalse(m.hasMore)
        gate.drain(); await settle()
        m.retry(); await settle()
        XCTAssertTrue(m.bodyLoading); XCTAssertNil(m.bodyError)
        gate.reply(.chunks, page(["c1"], total: 1)); await settle()
        XCTAssertEqual(ids(m), ["c1"]); XCTAssertFalse(m.bodyLoading)
    }

    func testCancelledBodyClosesLoadingWithoutError() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        gate.fail(.chunks, CancellationError()); await settle()
        XCTAssertFalse(m.bodyLoading); XCTAssertNil(m.bodyError)
    }

    func testOldDocumentResponsesNeverLandOnNewDocument() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        m.disappear()
        m.appear(docId: "B", revision: 1); await settle()
        XCTAssertEqual(gate.factoryCount, 2, "a new document starts a new reading cycle (new client)")
        gate.reply(.chunks, doc: "A", page(["a1"], total: 9))
        gate.reply(.info, doc: "A", info("A 的标题")); await settle()
        XCTAssertEqual(ids(m), []); XCTAssertNil(m.info); XCTAssertTrue(m.bodyLoading, "late A cannot end B's loading")
        gate.reply(.chunks, doc: "B", page(["b1"], total: 1)); await settle()
        XCTAssertEqual(ids(m), ["b1"]); XCTAssertFalse(m.hasMore)
    }

    func testHiddenLateResponsesDoNotWriteAndReturnFillsOnlyMissingOnce() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        gate.reply(.chunks, page(["c1"], total: 1))
        gate.reply(.info, info("t")); await settle()
        m.disappear()
        gate.reply(.ocr, ocr(pending: [2])); gate.reply(.provenance, provenance); await settle()
        XCTAssertNil(m.ocr, "responses arriving while hidden are dropped")
        XCTAssertNil(m.provenance)
        m.appear(docId: "A", revision: 1); await settle()
        XCTAssertEqual(gate.count(.chunks), 1); XCTAssertEqual(gate.count(.info), 1)
        XCTAssertEqual(gate.count(.ocr), 2); XCTAssertEqual(gate.count(.provenance), 2, "only the missing parts are re-read")
        XCTAssertEqual(ids(m), ["c1"])
        gate.reply(.ocr, ocr(pending: [2])); gate.reply(.provenance, provenance); await settle()
        m.disappear(); m.appear(docId: "A", revision: 1); await settle()
        XCTAssertEqual(gate.calls.count, 6, "everything loaded: reappearing issues nothing")
    }

    func testHiddenConnectionChangeDoesNotFetchAndReturnReloadsOnce() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        gate.reply(.chunks, page(["old"], total: 3)); await settle()
        m.disappear()
        m.connectionChanged(to: 2); await settle()
        XCTAssertEqual(gate.calls.count, 4, "hidden page never fetches")
        XCTAssertEqual(ids(m), [], "old-connection body is invalid at once")
        gate.reply(.info, info("old")); await settle()
        XCTAssertNil(m.info)
        m.appear(docId: "A", revision: 2); await settle()
        XCTAssertEqual(gate.factoryCount, 2, "new connection, new client")
        XCTAssertEqual(gate.count(.chunks), 2)
        m.connectionChanged(to: 2); m.appear(docId: "A", revision: 2); await settle()
        XCTAssertEqual(gate.count(.chunks), 2, "same revision is a no-op")
    }

    func testVisibleConnectionChangeDropsOldPagingAndBody() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        gate.reply(.chunks, offset: 0, page(["c1", "c2"], total: 4)); await settle()
        m.loadMore(); await settle()
        XCTAssertEqual(gate.pending(.chunks, offset: 2).count, 1)
        m.connectionChanged(to: 2); await settle()
        XCTAssertEqual(ids(m), []); XCTAssertFalse(m.moreLoading); XCTAssertTrue(m.bodyLoading)
        gate.reply(.chunks, offset: 2, page(["old3", "old4"], total: 4)); await settle()
        XCTAssertEqual(ids(m), [], "old connection's page cannot land")
        gate.reply(.chunks, offset: 0, page(["n1"], total: 1)); await settle()
        XCTAssertEqual(ids(m), ["n1"]); XCTAssertFalse(m.hasMore)
    }

    func testMoreWaitsForFirstPageAndCoalescesRepeatedTaps() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        m.loadMore(); await settle()
        XCTAssertEqual(gate.count(.chunks), 1, "no more before the first page")
        gate.reply(.chunks, page(["c1", "c2"], total: 6)); await settle()
        m.loadMore(); m.loadMore(); m.loadMore(); await settle()
        XCTAssertEqual(gate.pending(.chunks, offset: 2).count, 1, "repeated taps are one request")
        XCTAssertTrue(m.moreLoading)
        gate.reply(.chunks, offset: 2, page(["c2", "c3", "c4"], total: 6)); await settle()
        XCTAssertEqual(ids(m), ["c1", "c2", "c3", "c4"], "overlapping chunk is not duplicated")
        XCTAssertFalse(m.moreLoading)
        m.loadMore(); await settle()
        XCTAssertEqual(gate.pending(.chunks, offset: 5).count, 1, "offset advances by the accepted page size")
        gate.reply(.chunks, offset: 5, page([], total: 5)); await settle()
        XCTAssertFalse(m.hasMore, "server total shrank to what we already have: done, no error")
        XCTAssertNil(m.moreError)
        m.loadMore(); await settle()
        XCTAssertEqual(gate.count(.chunks), 3, "no more past the last page")
    }

    func testMoreFailureAndZeroProgressAreRetryableWithoutLooping() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        gate.reply(.chunks, page(["c1"], total: 3)); await settle()
        m.loadMore(); await settle()
        gate.fail(.chunks, offset: 1); await settle()
        XCTAssertNotNil(m.moreError); XCTAssertFalse(m.moreLoading); XCTAssertTrue(m.hasMore)
        XCTAssertEqual(gate.count(.chunks), 2, "failure does not auto-retry")
        m.loadMore(); await settle()
        gate.reply(.chunks, offset: 1, page([], total: 3)); await settle()
        XCTAssertNotNil(m.moreError, "zero progress is reported, not looped")
        XCTAssertFalse(m.moreLoading); XCTAssertEqual(gate.count(.chunks), 3)
        m.loadMore(); await settle()
        XCTAssertEqual(gate.pending(.chunks, offset: 1).count, 1, "retry asks the same offset")
        gate.reply(.chunks, offset: 1, page(["c2", "c3"], total: 3)); await settle()
        XCTAssertEqual(ids(m), ["c1", "c2", "c3"]); XCTAssertNil(m.moreError); XCTAssertFalse(m.hasMore)
    }

    func testCancelledMoreClosesLoadingWithoutError() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        gate.reply(.chunks, page(["c1"], total: 2)); await settle()
        m.loadMore(); await settle()
        gate.fail(.chunks, offset: 1, CancellationError()); await settle()
        XCTAssertFalse(m.moreLoading); XCTAssertNil(m.moreError)
        m.loadMore(); await settle()
        XCTAssertEqual(gate.pending(.chunks, offset: 1).count, 1, "still at the same offset")
    }

    func testDisappearDuringMoreDropsPageAndReturnKeepsOffset() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        gate.reply(.chunks, page(["c1"], total: 3)); await settle()
        m.loadMore(); await settle()
        m.disappear()
        XCTAssertFalse(m.moreLoading)
        gate.reply(.chunks, offset: 1, page(["c2"], total: 3)); await settle()
        XCTAssertEqual(ids(m), ["c1"], "page arriving while hidden is dropped")
        m.appear(docId: "A", revision: 1); await settle()
        m.loadMore(); await settle()
        XCTAssertEqual(gate.pending(.chunks, offset: 1).count, 1, "next offset was not advanced by the dropped page")
    }

    func testRetryDuringMoreDoesNotLetOldPageLand() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        gate.reply(.chunks, page(["c1"], total: 3))
        gate.fail(.info); await settle()
        m.loadMore(); await settle()
        m.retry(); await settle()                    // re-reads info, cancels the in-flight page
        XCTAssertFalse(m.moreLoading)
        gate.reply(.chunks, offset: 1, page(["c2"], total: 3)); await settle()
        XCTAssertEqual(ids(m), ["c1"])
        m.loadMore(); await settle()
        gate.reply(.chunks, offset: 1, page(["c2"], total: 3)); await settle()
        XCTAssertEqual(ids(m), ["c1", "c2"])
    }

    func testMissingConnectionShowsRetryableBodyError() async {
        let m = makeModel()
        gate.factoryError = SearchFixtureError()
        m.appear(docId: "A", revision: 1); await settle()
        XCTAssertTrue(gate.calls.isEmpty); XCTAssertNotNil(m.bodyError); XCTAssertFalse(m.bodyLoading)
        gate.factoryError = nil
        m.retry(); await settle()
        XCTAssertEqual(gate.count(.chunks), 1)
    }

    func testReloadOCRStaysInCycle() async {
        let m = makeModel()
        m.appear(docId: "A", revision: 1); await settle()
        gate.reply(.ocr, ocr(pending: [1])); await settle()
        guard let cycle = m.currentCycle else { return XCTFail("no reading cycle") }
        let refresh = Task { await m.reloadOCR(for: cycle) }
        await settle()
        m.disappear()
        gate.reply(.ocr, ocr(pending: [])); await refresh.value
        XCTAssertEqual(m.ocr?.pendingPages, [1], "OCR refresh arriving after leaving is dropped")
    }
}
