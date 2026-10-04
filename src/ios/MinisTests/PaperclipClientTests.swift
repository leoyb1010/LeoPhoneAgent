import Foundation
import XCTest

private final class PaperclipTestProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, String, String))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let handler = Self.handler; Self.lock.unlock()
        do {
            let result = try handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: result.0, httpVersion: nil,
                                           headerFields: ["Content-Type": result.2])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(result.1.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
    static func body(_ request: URLRequest) throws -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    static func install(_ handler: @escaping @Sendable (URLRequest) throws -> (Int, String, String)) {
        lock.lock(); Self.handler = handler; lock.unlock()
    }
}

@MainActor
final class PaperclipClientTests: XCTestCase {
    private static let session = #"{"session":{"id":"s","userId":"human"},"user":{"id":"human"}}"#
    private static let issue = #"{"id":"issue","companyId":"company","title":"任务","status":"todo","priority":"medium"}"#
    private func client() throws -> PaperclipClient {
        let p = try PaperclipProfile(name: "测试", address: "https://example.com")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PaperclipTestProtocol.self]
        let cookie = HTTPCookie(properties: [.domain: "example.com", .path: "/", .name: "paperclip-test.session_token", .value: "fixture", .secure: "TRUE"])!
        return PaperclipClient(profile: p, configuration: config, readCookies: { [cookie] })
    }
    func testAuthCookieOriginAndIdempotencyAreSentWithoutBearerKeys() async throws {
        let id = UUID()
        let session = Self.session; let issue = Self.issue
        PaperclipTestProtocol.install { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "Origin"), "https://example.com")
            XCTAssertTrue(request.value(forHTTPHeaderField: "Cookie")?.contains("paperclip-test.session_token=fixture") == true)
            if request.url!.path == "/api/auth/get-session" { return (200, session, "application/json") }
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url!.path, "/api/companies/company/issues")
            let body = try PaperclipTestProtocol.body(request)
            XCTAssertEqual(body["idempotencyKey"] as? String, id.uuidString)
            return (201, issue, "application/json")
        }
        let result = try await client().create(companyID: "company", userID: "human", title: "任务", description: "", agentID: nil, requestID: id)
        XCTAssertEqual(result.id, "issue")
    }
    func testChangedHumanStopsBeforeMutation() async throws {
        let session = Self.session
        PaperclipTestProtocol.install { request in
            XCTAssertEqual(request.url!.path, "/api/auth/get-session")
            return (200, session, "application/json")
        }
        do {
            _ = try await client().create(companyID: "company", userID: "other", title: "任务", description: "", agentID: nil, requestID: UUID())
            XCTFail("不同用户不得提交")
        } catch { XCTAssertEqual(error as? PaperclipError, .identityChanged) }
    }
    func testCreateTimeoutIsUncertainAndIsNotRetried() async throws {
        let session = Self.session
        PaperclipTestProtocol.install { request in
            if request.url!.path == "/api/auth/get-session" { return (200, session, "application/json") }
            throw URLError(.timedOut)
        }
        do {
            _ = try await client().create(companyID: "company", userID: "human", title: "任务", description: "", agentID: nil, requestID: UUID())
            XCTFail("超时不能报告成功")
        } catch { XCTAssertEqual(error as? PaperclipError, .uncertain) }
    }
    func testHealthRejectsHTMLAndLocalTrustedServer() async throws {
        for result in [(200, "<html>登录</html>", "text/html"), (200, #"{"status":"ok","deploymentMode":"local_trusted"}"#, "application/json")] {
            PaperclipTestProtocol.install { _ in result }
            do { _ = try await client().health(); XCTFail("不兼容服务不能启用") } catch {}
        }
    }
    func testMutationRequiresActualReceipt() async throws {
        let session = Self.session
        for result in [(500, "{}", "application/json"), (200, "{}", "application/json"), (200, "<html/>", "text/html")] {
            PaperclipTestProtocol.install { request in request.url!.path == "/api/auth/get-session" ? (200, session, "application/json") : result }
            do {
                _ = try await client().create(companyID: "company", userID: "human", title: "任务", description: "", agentID: nil, requestID: UUID())
                XCTFail("缺失回执不能报告成功")
            } catch { XCTAssertEqual(error as? PaperclipError, .uncertain) }
        }
    }
    func testCookieFilterRejectsParentDomainSiblingPathInsecureAndExpired() throws {
        let target = URL(string: "https://api.example.com/api/issues")!
        func cookie(_ domain: String, path: String = "/", secure: Bool = true, expires: Date = .distantFuture) -> HTTPCookie {
            var properties: [HTTPCookiePropertyKey: Any] = [.domain: domain, .path: path, .name: "session", .value: "fixture", .expires: expires]
            if secure { properties[.secure] = "TRUE" }
            return HTTPCookie(properties: properties)!
        }
        let cookies = [cookie("api.example.com"), cookie("example.com"), cookie("evil.example.com"), cookie("api.example.com", path: "/api/issue"), cookie("api.example.com", secure: false), cookie("api.example.com", expires: .distantPast)]
        XCTAssertEqual(PaperclipClient.cookies(cookies, for: target).count, 1)
    }
    func testCrossCompanyIssueFailsClosed() async throws {
        let session = Self.session; let issue = Self.issue.replacingOccurrences(of: "company", with: "other")
        PaperclipTestProtocol.install { request in request.url!.path == "/api/auth/get-session" ? (200, session, "application/json") : (200, "[\(issue)]", "application/json") }
        do { _ = try await client().issues(companyID: "company", userID: "human"); XCTFail("不得混入其他公司数据") }
        catch { XCTAssertEqual(error as? PaperclipError, .identityChanged) }
    }
}
