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


private final class PaperclipRequestLedger: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    func append(_ value: String) { lock.lock(); entries.append(value); lock.unlock() }
    var values: [String] { lock.lock(); defer { lock.unlock() }; return entries }
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
        let ledger = PaperclipRequestLedger()
        PaperclipTestProtocol.install { request in
            if request.url!.path == "/api/auth/get-session" { return (200, session, "application/json") }
            ledger.append(request.httpMethod ?? "")
            throw URLError(.timedOut)
        }
        do {
            _ = try await client().create(companyID: "company", userID: "human", title: "任务", description: "", agentID: nil, requestID: UUID())
            XCTFail("超时不能报告成功")
        } catch { XCTAssertEqual(error as? PaperclipError, .uncertain) }
        XCTAssertEqual(ledger.values, ["POST"])
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
    func testExplicitReplyRetryKeepsClientRequestIDAndNeverFallsBack() async throws {
        let session = Self.session; let issue = Self.issue
        let ledger = PaperclipRequestLedger()
        let requestID = UUID()
        PaperclipTestProtocol.install { request in
            switch request.url!.path {
            case "/api/auth/get-session": return (200, session, "application/json")
            case "/api/issues/issue": return (200, issue, "application/json")
            case "/api/issues/issue/comments":
                let body = try PaperclipTestProtocol.body(request)
                ledger.append(try XCTUnwrap(body["clientRequestId"] as? String))
                XCTAssertEqual(body["body"] as? String, "继续处理")
                throw URLError(.networkConnectionLost)
            default: XCTFail("不得走其他后端或接口"); return (404, "{}", "application/json")
            }
        }
        let client = try client()
        let ref = PaperclipTaskReference(profileID: client.profile.id, origin: client.profile.origin,
                                         companyID: "company", userID: "human", issueID: "issue")
        for _ in 0..<2 {
            do { _ = try await client.reply(ref, body: "继续处理", requestID: requestID); XCTFail("断网回执不确定") }
            catch { XCTAssertEqual(error as? PaperclipError, .uncertain) }
        }
        XCTAssertEqual(ledger.values, [requestID.uuidString, requestID.uuidString])
    }

    func testUnrelatedApprovalCannotBeResolved() async throws {
        let session = Self.session; let issue = Self.issue
        let ledger = PaperclipRequestLedger()
        PaperclipTestProtocol.install { request in
            ledger.append(request.httpMethod ?? "")
            switch request.url!.path {
            case "/api/auth/get-session": return (200, session, "application/json")
            case "/api/issues/issue": return (200, issue, "application/json")
            case "/api/issues/issue/approvals": return (200, "[]", "application/json")
            default: XCTFail("未关联审批不得提交"); return (404, "{}", "application/json")
            }
        }
        let client = try client()
        let ref = PaperclipTaskReference(profileID: client.profile.id, origin: client.profile.origin,
                                         companyID: "company", userID: "human", issueID: "issue")
        let approval = try JSONDecoder().decode(PaperclipApproval.self, from: Data(#"{"id":"foreign","companyId":"company","type":"hire_agent","status":"pending","payload":{}}"#.utf8))
        do { _ = try await client.resolve(ref, approval: approval, approve: true, note: ""); XCTFail("不得审批其他任务") }
        catch { XCTAssertEqual(error as? PaperclipError, .http(409)) }
        XCTAssertFalse(ledger.values.contains("POST"))
    }

    func testApprovalPayloadChangeAfterConfirmationStopsBeforePost() async throws {
        let session = Self.session; let issue = Self.issue
        let approvedSnapshot = #"{"id":"approval","companyId":"company","type":"hire_agent","status":"pending","payload":{"budget":100}}"#
        let changedSnapshot = approvedSnapshot.replacingOccurrences(of: "100", with: "10000")
        let ledger = PaperclipRequestLedger()
        PaperclipTestProtocol.install { request in
            ledger.append(request.httpMethod ?? "")
            switch request.url!.path {
            case "/api/auth/get-session": return (200, session, "application/json")
            case "/api/issues/issue": return (200, issue, "application/json")
            case "/api/issues/issue/approvals": return (200, "[\(changedSnapshot)]", "application/json")
            default: XCTFail("审批内容改变后不得提交"); return (404, "{}", "application/json")
            }
        }
        let client = try client()
        let ref = PaperclipTaskReference(profileID: client.profile.id, origin: client.profile.origin,
                                         companyID: "company", userID: "human", issueID: "issue")
        let approval = try JSONDecoder().decode(PaperclipApproval.self, from: Data(approvedSnapshot.utf8))
        do { _ = try await client.resolve(ref, approval: approval, approve: true, note: ""); XCTFail("不得批准未展示的变更") }
        catch { XCTAssertEqual(error as? PaperclipError, .http(409)) }
        XCTAssertFalse(ledger.values.contains("POST"))
    }

    func testBlockedStatusNeedsExplicitValidActionBeforeNetwork() async throws {
        PaperclipTestProtocol.install { _ in XCTFail("缺少解除阻塞说明时不得发请求"); return (500, "{}", "application/json") }
        let client = try client()
        let ref = PaperclipTaskReference(profileID: client.profile.id, origin: client.profile.origin,
                                         companyID: "company", userID: "human", issueID: "issue")
        for action in [nil, "", " \n ", String(repeating: "🚀", count: 1001)] as [String?] {
            do { _ = try await client.setStatus(ref, status: .blocked, unblockAction: action); XCTFail("不允许空白或超长说明") }
            catch { XCTAssertEqual(error as? PaperclipError, .unblockActionRequired) }
        }
    }

    func testBlockedStatusPinsDescriptorToTaskHumanAndTrimsAction() async throws {
        let session = Self.session; let issue = Self.issue
        PaperclipTestProtocol.install { request in
            if request.url!.path == "/api/auth/get-session" { return (200, session, "application/json") }
            if request.httpMethod != "PATCH" { return (200, issue, "application/json") }
            let body = try PaperclipTestProtocol.body(request)
            XCTAssertEqual(Set(body.keys), Set(["status", "unblockDescriptor"]))
            XCTAssertEqual(body["status"] as? String, "blocked")
            let descriptor = try XCTUnwrap(body["unblockDescriptor"] as? [String: Any])
            XCTAssertEqual(Set(descriptor.keys), Set(["owner", "action"]))
            XCTAssertEqual(descriptor["action"] as? String, "请确认访问范围")
            XCTAssertEqual(descriptor["owner"] as? [String: String], ["userId": "human"])
            var receipt = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(issue.utf8)) as? [String: Any])
            receipt["status"] = "blocked"
            receipt["unblockDescriptor"] = descriptor
            return (200, String(decoding: try JSONSerialization.data(withJSONObject: receipt), as: UTF8.self), "application/json")
        }
        let client = try client()
        let ref = PaperclipTaskReference(profileID: client.profile.id, origin: client.profile.origin,
                                         companyID: "company", userID: "human", issueID: "issue")
        let result = try await client.setStatus(ref, status: .blocked, unblockAction: " \n请确认访问范围  ")
        XCTAssertEqual(result.status, "blocked")
    }

    func testBlockedReceiptMustConfirmSameOwnerAndAction() async throws {
        let session = Self.session; let issue = Self.issue
        for descriptor in [
            #"{"owner":{"userId":"human"},"action":"另一项未确认条件"}"#,
            #"{"owner":{"userId":"other"},"action":"请确认访问范围"}"#,
            "null"
        ] {
            PaperclipTestProtocol.install { request in
                if request.url!.path == "/api/auth/get-session" { return (200, session, "application/json") }
                if request.httpMethod != "PATCH" { return (200, issue, "application/json") }
                let base = issue.replacingOccurrences(of: "\"status\":\"todo\"", with: "\"status\":\"blocked\"")
                let receipt = String(base.dropLast()) + ",\"unblockDescriptor\":\(descriptor)}"
                return (200, receipt, "application/json")
            }
            let client = try client()
            let ref = PaperclipTaskReference(profileID: client.profile.id, origin: client.profile.origin,
                                             companyID: "company", userID: "human", issueID: "issue")
            do { _ = try await client.setStatus(ref, status: .blocked, unblockAction: "请确认访问范围"); XCTFail("不能确认不同或丢失的解除条件") }
            catch { XCTAssertEqual(error as? PaperclipError, .uncertain) }
        }
    }

    func testOtherStatusesNeverSendUnblockDescriptor() async throws {
        let session = Self.session; let issue = Self.issue
        for status in PaperclipIssueStatus.allCases where status != .blocked {
            let raw = status.rawValue
            PaperclipTestProtocol.install { request in
                if request.url!.path == "/api/auth/get-session" { return (200, session, "application/json") }
                if request.httpMethod != "PATCH" { return (200, issue, "application/json") }
                let body = try PaperclipTestProtocol.body(request)
                XCTAssertEqual(Set(body.keys), Set(["status"]))
                XCTAssertEqual(body["status"] as? String, raw)
                return (200, issue.replacingOccurrences(of: "\"status\":\"todo\"", with: "\"status\":\"\(raw)\""), "application/json")
            }
            let client = try client()
            let ref = PaperclipTaskReference(profileID: client.profile.id, origin: client.profile.origin,
                                             companyID: "company", userID: "human", issueID: "issue")
            _ = try await client.setStatus(ref, status: status, unblockAction: "此说明不得随其他状态发送")
        }
    }

    func testStatusUpdateRequiresRequestedStateInReceipt() async throws {
        let session = Self.session; let issue = Self.issue
        PaperclipTestProtocol.install { request in
            request.url!.path == "/api/auth/get-session" ? (200, session, "application/json") : (200, issue, "application/json")
        }
        let client = try client()
        let ref = PaperclipTaskReference(profileID: client.profile.id, origin: client.profile.origin,
                                         companyID: "company", userID: "human", issueID: "issue")
        do { _ = try await client.setStatus(ref, status: .done); XCTFail("返回旧状态不得报告修改成功") }
        catch { XCTAssertEqual(error as? PaperclipError, .uncertain) }
    }

    func testInvalidatedClientDoesNotSendRequests() async throws {
        PaperclipTestProtocol.install { _ in XCTFail("退出后不得重用会话"); return (500, "{}", "application/json") }
        let client = try client()
        client.invalidate()
        do { _ = try await client.humanSession(); XCTFail("退出后不得验证成功") }
        catch { XCTAssertEqual(error as? PaperclipError, .signedOut) }
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
        let session = Self.session; let issue = Self.issue.replacingOccurrences(of: "\"companyId\":\"company\"", with: "\"companyId\":\"other\"")
        // 先验证测试样本形状，避免把 companyId 键一起替换而只测到解码失败。
        let fixture = try JSONDecoder().decode(PaperclipIssue.self, from: Data(issue.utf8))
        XCTAssertEqual(fixture.companyId, "other")
        XCTAssertEqual(fixture.id, "issue")
        PaperclipTestProtocol.install { request in request.url!.path == "/api/auth/get-session" ? (200, session, "application/json") : (200, "[\(issue)]", "application/json") }
        do { _ = try await client().issues(companyID: "company", userID: "human"); XCTFail("不得混入其他公司数据") }
        catch { XCTAssertEqual(error as? PaperclipError, .identityChanged) }
    }
}
