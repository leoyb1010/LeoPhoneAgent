import XCTest

/// [T-brain] 资料库网关契约 v1 的 JSON 夹具:每个接口的成功体、错误体、请求构造。
final class BrainClientDecodingTests: XCTestCase {

    private func data(_ s: String) -> Data { Data(s.utf8) }

    func testHealthDecodes() throws {
        let h = try BrainJSON.decode(BrainHealth.self, from: data("""
        {"ok":true,"version":"1.0.0","archive":{"files":17348,"documents":662,"chunks":18309,"cards":6,"last_scan":"2026-10-10T08:00:00Z"},
         "semantic":{"ready":true,"model":"bge-m3","vectors":18315,"pending":0}}
        """))
        XCTAssertTrue(h.ok)
        XCTAssertEqual(h.files, 17348)
        XCTAssertEqual(h.cards, 6)
        XCTAssertTrue(h.semanticReady)
        XCTAssertEqual(h.semanticModel, "bge-m3")
    }

    func testHealthSemanticNotReady() throws {
        let h = try BrainJSON.decode(BrainHealth.self, from: data(#"{"ok":true,"archive":{"files":1},"semantic":{"ready":false}}"#))
        XCTAssertFalse(h.semanticReady)
        XCTAssertNil(h.cards)
    }

    func testSearchDecodesItemsMatchAndLooseTypes() throws {
        let r = try BrainJSON.decode(BrainSearchResponse.self, from: data("""
        {"items":[
          {"type":"file","id":123,"title":"报价单","path":"桌面/报价.pdf","source":"desktop","ext":"pdf","category":"合同",
           "project":null,"privacy":"general","status":"indexed","score":0.83,"size":2048,"mtime":1728000000,
           "match":{"locator":"第3页","excerpt":"总价 12 万"}},
          {"type":"card","id":"c-9","title":"报价原则","privacy":"general","status":"confirmed","match":null},
          {"type":"file","id":"p1","title":"体检","privacy":"private","match":{"locator":"第1页","excerpt":"…"}}
        ],"total":3,"mode":"hybrid","semantic_used":true}
        """))
        XCTAssertEqual(r.items.count, 3)
        XCTAssertEqual(r.items[0].id, "123")
        XCTAssertEqual(r.items[0].mtime, "1728000000")
        XCTAssertEqual(r.items[0].match?.locator, "第3页")
        XCTAssertTrue(r.items[1].isCard)
        XCTAssertNil(r.items[1].match)
        XCTAssertEqual(r.items[2].privacy, .private)
        XCTAssertEqual(r.mode, "hybrid")
        XCTAssertTrue(r.semanticUsed)
    }

    func testSearchKeywordFallback() throws {
        let r = try BrainJSON.decode(BrainSearchResponse.self, from: data(#"{"items":[],"total":0,"mode":"keyword","semantic_used":false}"#))
        XCTAssertTrue(r.items.isEmpty)
        XCTAssertFalse(r.semanticUsed)
    }

    func testFileMetaChunksLinkDecode() throws {
        let m = try BrainJSON.decode(BrainFileMeta.self, from: data("""
        {"id":"f1","title":"方案","path":"a/b.docx","source":"desktop","ext":"docx","size":10,"mtime":"2026-01-01",
         "sha256":"ab","category":"方案","project":"X","privacy":"general","status":"indexed","summary":"摘要",
         "chunk_total":40,"original_available":true,"backup_available":false}
        """))
        XCTAssertEqual(m.chunkTotal, 40)
        XCTAssertTrue(m.originalAvailable)
        XCTAssertFalse(m.backupAvailable)
        let p = try BrainJSON.decode(BrainChunkPage.self, from: data(#"{"chunks":[{"id":1,"locator":"第1页","text":"正文","method":"pdf"}],"total":40}"#))
        XCTAssertEqual(p.chunks.first?.id, "1")
        XCTAssertEqual(p.total, 40)
        let l = try BrainJSON.decode(BrainDownloadLink.self, from: data(#"{"url":"/v1/dl/abc.def","expires_in":300,"filename":"方案.docx"}"#))
        XCTAssertEqual(l.expiresIn, 300)
        XCTAssertEqual(l.filename, "方案.docx")
    }

    func testCardsDecode() throws {
        let list = try BrainJSON.decode(BrainCardList.self, from: data(#"{"items":[{"id":"c1","title":"T","category":"x","status":"draft","version":3,"updated_at":"2026","summary":"s"}],"total":1}"#))
        XCTAssertEqual(list.items.first?.version, 3)
        let card = try BrainJSON.decode(BrainCard.self, from: data("""
        {"id":"c1","title":"T","category":null,"body":"# 正文","status":"confirmed","version":4,"created_at":"a","updated_at":"b",
         "sources":[{"file_id":"f1","locator":"第2页","sha256":"x"}],"history":[{"version":3,"title":"旧","saved_at":"c"}]}
        """))
        XCTAssertEqual(card.version, 4)
        XCTAssertEqual(card.sources, [BrainCardSource(fileId: "f1", locator: "第2页", sha256: "x")])
        XCTAssertEqual(card.history.first?.version, 3)
    }

    func testInboxAndAuditDecode() throws {
        let r = try BrainJSON.decode(BrainInboxReceipt.self, from: data(#"{"name":"纪要.md","file_id":null,"job":"j1","message":"已收件"}"#))
        XCTAssertEqual(r.name, "纪要.md")
        XCTAssertNil(r.fileId)
        let a = try BrainJSON.decode(BrainAuditList.self, from: data(#"{"items":[{"at":"t","endpoint":"/v1/search","target":null,"bytes":10,"status":200}]}"#))
        XCTAssertEqual(a.items.first?.status, 200)
    }

    func testMalformedBodyIsInvalidResponse() {
        XCTAssertThrowsError(try BrainJSON.decode(BrainHealth.self, from: data("<html>"))) {
            XCTAssertEqual($0 as? BrainError, .invalidResponse)
        }
    }

    // MARK: Errors

    func testErrorMapping() {
        let e401 = BrainError.from(status: 401, body: data(#"{"error":"令牌无效","code":"unauthorized"}"#), retryAfter: nil)
        XCTAssertEqual(e401, .unauthorized)
        let e403 = BrainError.from(status: 403, body: data(#"{"error":"没有私密权限","code":"forbidden"}"#), retryAfter: nil)
        XCTAssertEqual(e403, .forbidden("没有私密权限"))
        XCTAssertEqual(e403.message, "没有私密权限")
        XCTAssertEqual(BrainError.from(status: 409, body: data(#"{"error":"x","code":"version_conflict"}"#), retryAfter: nil), .versionConflict)
        XCTAssertEqual(BrainError.from(status: 429, body: data(#"{"error":"x","code":"rate_limited"}"#), retryAfter: "17"), .rateLimited(retryAfter: 17))
        XCTAssertEqual(BrainError.from(status: 404, body: nil, retryAfter: nil), .notFound)
        XCTAssertEqual(BrainError.from(status: 500, body: data("oops"), retryAfter: nil), .server(status: 500, message: nil))
        for e in [BrainError.unauthorized, .forbidden(nil), .versionConflict, .rateLimited(retryAfter: nil), .offline, .timeout] {
            XCTAssertFalse(e.message.isEmpty)
        }
    }

    func testOfflineMapping() {
        XCTAssertEqual(BrainError.from(urlErrorCode: NSURLErrorNotConnectedToInternet), .offline)
        XCTAssertEqual(BrainError.from(urlErrorCode: NSURLErrorCannotFindHost), .offline)
        XCTAssertEqual(BrainError.from(urlErrorCode: NSURLErrorTimedOut), .timeout)
        XCTAssertTrue(BrainError.offline.isOffline)
        XCTAssertFalse(BrainError.unauthorized.isOffline)
    }

    // MARK: Requests

    func testEndpointBuilding() throws {
        let ep = try XCTUnwrap(BrainEndpoint(baseString: "https://wenjian.leoyuan.top/"))
        let search = ep.search(query: "报价 单", scope: .files, limit: 99, includePrivate: false)
        let comps = try XCTUnwrap(URLComponents(url: search, resolvingAgainstBaseURL: false))
        XCTAssertEqual(comps.path, "/v1/search")
        let q = Dictionary(uniqueKeysWithValues: (comps.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(q["q"], "报价 单")
        XCTAssertEqual(q["scope"], "files")
        XCTAssertEqual(q["limit"], "50")
        XCTAssertEqual(q["include_private"], "0")
        XCTAssertEqual(ep.chunks("a/b", offset: 0, limit: 40).path, "/v1/files/a%2Fb/chunks".removingPercentEncoding)
        XCTAssertTrue(ep.chunks("a/b", offset: 0).absoluteString.contains("/v1/files/a%2Fb/chunks"))
        XCTAssertTrue(ep.chunks("f", offset: 0, limit: 40).absoluteString.contains("limit=12"))
        XCTAssertEqual(ep.card("c1", version: 2).query, "version=2")
    }

    func testBaseURLValidation() {
        XCTAssertNotNil(BrainEndpoint.normalizedBase("https://wenjian.leoyuan.top"))
        XCTAssertNil(BrainEndpoint.normalizedBase("http://wenjian.leoyuan.top"))
        XCTAssertNil(BrainEndpoint.normalizedBase("https://user:pw@wenjian.leoyuan.top"))
        XCTAssertNil(BrainEndpoint.normalizedBase("https://wenjian.leoyuan.top?x=1"))
        XCTAssertNil(BrainEndpoint.normalizedBase("wenjian.leoyuan.top"))
        XCTAssertNotNil(BrainEndpoint.normalizedBase("http://127.0.0.1:8878"))
    }

    func testDownloadPathAndRedirectsStayOnHost() throws {
        let ep = try XCTUnwrap(BrainEndpoint(baseString: BrainEndpoint.defaultBaseURL))
        XCTAssertEqual(ep.download("/v1/dl/abc")?.host, "wenjian.leoyuan.top")
        XCTAssertNil(ep.download("https://evil.example/v1/dl/abc"))
        XCTAssertNil(ep.download("/v1/dl/../files/1"))
        XCTAssertNil(ep.download("/v1/files/1"))
        let base = ep.base
        XCTAssertTrue(BrainEndpoint.allowsRedirect(from: base, to: URL(string: "https://wenjian.leoyuan.top/v1/x")!))
        XCTAssertFalse(BrainEndpoint.allowsRedirect(from: base, to: URL(string: "https://evil.example/v1/x")!))
        XCTAssertFalse(BrainEndpoint.allowsRedirect(from: base, to: URL(string: "http://wenjian.leoyuan.top/v1/x")!))
    }

    func testCredentialHeaders() {
        let c = BrainCredentials(token: "T", accessClientId: "id", accessClientSecret: "sec")
        XCTAssertEqual(c.headers()["Authorization"], "Bearer T")
        XCTAssertEqual(c.headers()["CF-Access-Client-Id"], "id")
        XCTAssertNil(c.headers(bearer: false)["Authorization"])
        XCTAssertNil(BrainCredentials(token: "T", accessClientId: "id", accessClientSecret: nil).headers()["CF-Access-Client-Id"])
    }

    func testCardDraftBodyAndInboxName() throws {
        var d = BrainCardDraft(id: "c1", version: 3, title: "T", body: "B")
        d.status = "bogus"
        d.sources = [BrainCardSource(fileId: "f1", locator: "第1页", sha256: nil), BrainCardSource(fileId: "", locator: nil, sha256: nil)]
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: d.jsonBody()) as? [String: Any])
        XCTAssertEqual(obj["status"] as? String, "draft")
        XCTAssertEqual(obj["version"] as? Int, 3)
        XCTAssertEqual((obj["sources"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual(BrainInboxNaming.headerValue(for: "../纪要/a.md").removingPercentEncoding, ".._纪要_a.md")
        XCTAssertFalse(BrainInboxNaming.headerValue(for: "a\nb.md").contains("\n"))
    }
}
