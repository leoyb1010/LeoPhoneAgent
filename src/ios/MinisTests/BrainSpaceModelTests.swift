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
