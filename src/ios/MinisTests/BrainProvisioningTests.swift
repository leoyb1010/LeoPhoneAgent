import XCTest

/// [T-brain] 无输入配置:令牌文件导入后删除、深链只认 brain/connect 且校验字符集与长度、令牌不进日志。
final class BrainProvisioningTests: XCTestCase {

    private let token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde"   // 43 chars

    private var tempDir: URL!

    override func setUpWithError() throws {
        tempDir = FileManager.default.temporaryDirectory.appendingPathComponent("BrainProv-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tempDir)
    }

    func testTokenValidator() {
        XCTAssertEqual(token.count, 43)
        XCTAssertTrue(BrainTokenValidator.isValid(token))
        XCTAssertFalse(BrainTokenValidator.isValid(String(token.dropLast())))
        XCTAssertFalse(BrainTokenValidator.isValid(token + "=="))
        XCTAssertFalse(BrainTokenValidator.isValid(token.replacingOccurrences(of: "A", with: "/")))
        XCTAssertFalse(BrainTokenValidator.isValid(String(repeating: "a", count: 129)))
        XCTAssertFalse(BrainTokenValidator.isValid("令牌令牌令牌令牌令牌令牌令牌令牌令牌令牌令牌令牌令牌令牌令牌令牌令牌令牌令牌令牌令牌令"))
    }

    func testTokenFileImportedThenDeleted() throws {
        let file = tempDir.appendingPathComponent("brain.token")
        try (token + "\nscopes=read,write:cards\n").write(to: file, atomically: true, encoding: .utf8)
        var stored: BrainConnectRequest?
        let outcome = BrainProvisioning.importTokenFile(at: file) { stored = $0; return true }
        XCTAssertEqual(outcome, .imported)
        XCTAssertEqual(stored?.token, token)
        XCTAssertEqual(stored?.scopes, ["read", "write:cards"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "token must not stay on disk")
    }

    func testInvalidTokenFileIsDeletedAndNotStored() throws {
        let file = tempDir.appendingPathComponent("brain.token")
        try "not a token".write(to: file, atomically: true, encoding: .utf8)
        var called = false
        XCTAssertEqual(BrainProvisioning.importTokenFile(at: file) { _ in called = true; return true }, .invalid)
        XCTAssertFalse(called)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testMissingFileAndStoreFailure() throws {
        let file = tempDir.appendingPathComponent("brain.token")
        XCTAssertEqual(BrainProvisioning.importTokenFile(at: file) { _ in true }, .none)
        try token.write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(BrainProvisioning.importTokenFile(at: file) { _ in false }, .storeFailed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testDeepLinkParsing() {
        let ok = URL(string: "leobot://brain/connect?token=\(token)&scopes=read,private,bogus")!
        guard case .success(let req) = BrainProvisioning.parse(url: ok) else { return XCTFail("should parse") }
        XCTAssertEqual(req.token, token)
        XCTAssertEqual(req.scopes, ["read", "private"])
        let canonical = URL(string: "leophoneagent://brain/connect?token=\(token)")!
        if case .failure = BrainProvisioning.parse(url: canonical) { XCTFail("canonical scheme must parse") }

        XCTAssertEqual(parseFailure("leobot://brain/connect"), .missingToken)
        XCTAssertEqual(parseFailure("leobot://brain/connect?token=short"), .invalidToken)
        XCTAssertEqual(parseFailure("leobot://brain/connect?token=\(token)%3Cx%3E"), .invalidToken)
        XCTAssertEqual(parseFailure("leobot://brain/other?token=\(token)"), .notBrainLink)
        XCTAssertEqual(parseFailure("https://brain/connect?token=\(token)"), .notBrainLink)
    }

    func testDeepLinkCannotRedirectBaseURL() {
        // 链接里带 base / host 参数也不会改服务地址:解析结果里根本没有这个字段。
        let url = URL(string: "leobot://brain/connect?token=\(token)&base=https://evil.example")!
        guard case .success(let req) = BrainProvisioning.parse(url: url) else { return XCTFail("should parse") }
        XCTAssertEqual(req, BrainConnectRequest(token: token, scopes: nil))
    }

    func testTokenNeverLogged() {
        let url = URL(string: "leobot://brain/connect?token=\(token)")!
        let redacted = BrainProvisioning.redacted(url)
        XCTAssertFalse(redacted.contains(token))
        XCTAssertTrue(redacted.contains("REDACTED"))
        for outcome in [BrainProvisioning.ImportOutcome.none, .imported, .invalid, .storeFailed] {
            XCTAssertFalse(outcome.logDescription.contains(token))
        }
        XCTAssertFalse(String(describing: BrainProvisioningError.invalidToken).contains(token))
    }

    func testRouterSourcesNeverLogTheURLQuery() throws {
        // DeepLinkRouter / BrainStore 的日志只能写 host 与结果,不能把整条 URL(含令牌)打出来。
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        for rel in ["Shared/DeepLinkRouter.swift", "Shared/Brain/BrainStore.swift"] {
            let src = try String(contentsOf: root.appendingPathComponent(rel), encoding: .utf8)
            for line in src.split(separator: "\n") where line.contains("Log.") || line.contains("log.") {
                XCTAssertFalse(line.contains("absoluteString"), "\(rel): \(line)")
                XCTAssertFalse(line.contains("\\(url)"), "\(rel): \(line)")
                XCTAssertFalse(line.contains("token)"), "\(rel): \(line)")
            }
        }
    }

    private func parseFailure(_ s: String) -> BrainProvisioningError? {
        guard let url = URL(string: s) else { return nil }
        if case .failure(let e) = BrainProvisioning.parse(url: url) { return e }
        return nil
    }
}
