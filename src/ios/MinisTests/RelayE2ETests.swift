import CryptoKit
import XCTest

/// [e2e] 经中继端到端加密:跨端向量、计数 / 重放 / 篡改、退回明文的判断、公钥固定规则。
/// 向量与 Mac 端 link/relayE2E.test.ts 的 VECTOR 一字不差;任一端改了线格式两边都会红。
final class RelayE2ETests: XCTestCase {
    private let macPrivate = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 1, count: 32))
    private let ephemeralPrivate = try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: Data(repeating: 2, count: 32))

    private func macSideKeys(ephemeral: Data) throws -> RelayE2E.Keys {
        let mac = macPrivate.publicKey.rawRepresentation
        return try RelayE2E.deriveKeys(privateKey: macPrivate, peer: ephemeral, ephemeral: ephemeral, mac: mac)
    }

    func testCrossPlatformVectorMatchesMac() throws {
        let macPublic = macPrivate.publicKey.rawRepresentation
        XCTAssertEqual(RelayE2E.base64url(macPublic), "pOCSkrZRwni5dyxWn1-puxPZBrRqtoyd-dwrRAn4ogk")
        let sealed = try RelayE2E.seal(inner: Data(#"{"method":"GET","path":"/health"}"#.utf8), macKey: macPublic,
                                       ephemeral: ephemeralPrivate)
        XCTAssertEqual(sealed.k, "zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk")
        XCTAssertEqual(sealed.c, "jB7nKhyYdOR2vLbrsAbGy_GqLMjxQvMpER-DW9fyMvCgO1oo0UPWI_EY8Yl8WbXCZQ")
        let mac = try macSideKeys(ephemeral: ephemeralPrivate.publicKey.rawRepresentation)
        XCTAssertEqual(mac.request.withUnsafeBytes { Data($0) }, sealed.keys.request.withUnsafeBytes { Data($0) })
        XCTAssertEqual(try RelayE2E.seal(Data(#"{"status":200,"body":{"ok":true}}"#.utf8), key: mac.response, counter: 0,
                                         aad: RelayE2E.aadResponse),
                       "jIS0IQWX_Zbx7nXKKNGLyy-mePuGESi9tcMqjK69ZNCv4A6lMLBu0NdGlw9CEufyRQ")
        XCTAssertEqual(try RelayE2E.seal(Data("hello".utf8), key: mac.response, counter: 1, aad: RelayE2E.aadResponse),
                       "fZrUWM84_raPXFTHcRfUbQv-lG5z")
    }

    func testReplyOpensTheEnvelopeAndRejectsTampering() throws {
        let macPublic = macPrivate.publicKey.rawRepresentation
        let inner = try XCTUnwrap(RelayE2E.inner(method: "post", path: "/harness/sessions/s1/send",
                                                 body: Data(#"{"text":"机密"}"#.utf8), requestId: "req-1"))
        let sealed = try RelayE2E.seal(inner: inner, macKey: macPublic)
        // Mac 端解开:内层原样,请求编号在里面。
        let mac = try macSideKeys(ephemeral: XCTUnwrap(RelayE2E.base64urlDecode(sealed.k)))
        let opened = try JSONSerialization.jsonObject(with: RelayE2E.open(sealed.c, key: mac.request, counter: 0,
                                                                        aad: RelayE2E.aadRequest)) as? [String: Any]
        XCTAssertEqual(opened?["method"] as? String, "POST")
        XCTAssertEqual(opened?["request_id"] as? String, "req-1")
        XCTAssertEqual((opened?["body"] as? [String: Any])?["text"] as? String, "机密")

        let reply = try RelayE2E.seal(Data(#"{"status":403,"body":{"error":{"message":"不行"}}}"#.utf8),
                                      key: mac.response, counter: 0, aad: RelayE2E.aadResponse)
        let envelope = try JSONSerialization.data(withJSONObject: ["v": 1, "c": reply])
        guard case .opened(let status, let body) = RelayE2E.reply(status: 403, data: envelope, keys: sealed.keys, queued: false)
        else { return XCTFail("应当解开") }
        XCTAssertEqual(status, 403)
        XCTAssertEqual(((try JSONSerialization.jsonObject(with: body) as? [String: Any])?["error"] as? [String: Any])?["message"] as? String, "不行")

        // 中继改了密文 / 换成别的请求的回复:解不开 → 退回明文。
        let tampered = try JSONSerialization.data(withJSONObject: ["v": 1, "c": String(reply.dropLast(2)) + "AA"])
        XCTAssertEqual(RelayE2E.reply(status: 200, data: tampered, keys: sealed.keys, queued: false), .fallback(disable: true))
        let other = try RelayE2E.seal(inner: inner, macKey: macPublic)
        XCTAssertEqual(RelayE2E.reply(status: 200, data: envelope, keys: other.keys, queued: false), .fallback(disable: true))
    }

    func testFallbackDecisions() {
        let json = { (obj: [String: Any]) in try! JSONSerialization.data(withJSONObject: obj) }
        // 旧 Mac:/e2e 不在白名单。
        XCTAssertEqual(RelayE2E.classify(status: 404, data: json(["error": ["message": "这个接口不对手机开放"]]), queued: false),
                       .fallback(disable: true))
        // 新 Mac 解不开(手机固定的是旧公钥)。
        XCTAssertEqual(RelayE2E.classify(status: 400, data: json(["error": ["code": "e2e_rejected"]]), queued: false),
                       .fallback(disable: true))
        // 旧中继不给 /e2e 排队:只对本来就要排队的请求退回明文排队,而且不关掉加密。
        let offline = json(["error": ["message": "这台 Mac 当前不在线"]])
        XCTAssertEqual(RelayE2E.classify(status: 502, data: offline, queued: true), .fallback(disable: false))
        XCTAssertEqual(RelayE2E.classify(status: 502, data: offline, queued: false), .passthrough)
        // 中继自己的回答原样交回:排队回执、钥匙不对。
        XCTAssertEqual(RelayE2E.classify(status: 202, data: json(["queued": true, "request_id": "r"]), queued: true), .passthrough)
        XCTAssertEqual(RelayE2E.classify(status: 401, data: json(["error": ["message": "unauthorized"]]), queued: false), .passthrough)
        // Mac 解开后内层 404(会话不存在)仍是信封,不能当成旧 Mac。
        if case .opened = RelayE2E.classify(status: 404, data: json(["v": 1, "c": "x"]), queued: false) {} else { XCTFail() }
    }

    func testStreamCountersRejectDropsReorderAndMissingHandshake() throws {
        let sealed = try RelayE2E.seal(inner: Data("{}".utf8), macKey: macPrivate.publicKey.rawRepresentation)
        let mac = try macSideKeys(ephemeral: XCTUnwrap(RelayE2E.base64urlDecode(sealed.k)))
        func frame(_ text: String, _ n: UInt64) throws -> String {
            String(data: try JSONSerialization.data(withJSONObject: [
                "v": 1, "c": try RelayE2E.seal(Data(text.utf8), key: mac.response, counter: n, aad: RelayE2E.aadResponse)]),
                encoding: .utf8)!
        }
        var opener = RelayE2E.StreamOpener(keys: sealed.keys)
        XCTAssertNil(try opener.next(frame(#"{"type":"e2e.open"}"#, 0)))
        XCTAssertTrue(opener.opened)
        XCTAssertEqual(try opener.next(frame(#"{"seq":1}"#, 1)), #"{"seq":1}"#)
        // 中继吞掉第 2 帧:第 3 帧按计数 2 解不开。
        XCTAssertThrowsError(try opener.next(frame(#"{"seq":3}"#, 3)))
        // 重放第 1 帧同样解不开。
        var replay = RelayE2E.StreamOpener(keys: sealed.keys)
        _ = try replay.next(frame(#"{"type":"e2e.open"}"#, 0))
        _ = try replay.next(frame(#"{"seq":1}"#, 1))
        XCTAssertThrowsError(try replay.next(frame(#"{"seq":1}"#, 1)))
        // 第 0 帧不是握手:不认。明文帧也不认。
        var noHandshake = RelayE2E.StreamOpener(keys: sealed.keys)
        XCTAssertThrowsError(try noHandshake.next(frame(#"{"seq":1}"#, 0)))
        var plain = RelayE2E.StreamOpener(keys: sealed.keys)
        XCTAssertThrowsError(try plain.next(#"{"event":"message.delta","delta":"hi"}"#))
    }

    func testPinningRules() {
        let a = RelayE2E.base64url(Data(repeating: 3, count: 32))
        let b = RelayE2E.base64url(Data(repeating: 4, count: 32))
        XCTAssertTrue(RelayE2E.shouldPin(current: nil, currentSource: nil, new: a, source: .relay))
        XCTAssertFalse(RelayE2E.shouldPin(current: a, currentSource: .qr, new: a, source: .qr))
        // 经中继拿到的不能顶掉扫码 / 直连固定的。
        XCTAssertFalse(RelayE2E.shouldPin(current: a, currentSource: .qr, new: b, source: .relay))
        XCTAssertFalse(RelayE2E.shouldPin(current: a, currentSource: .direct, new: b, source: .relay))
        // 中继首次信任的钥匙一旦存下,中继来源也不能再替换它;直连 / 扫码可以。
        XCTAssertFalse(RelayE2E.shouldPin(current: a, currentSource: .relay, new: b, source: .relay))
        XCTAssertTrue(RelayE2E.shouldPin(current: a, currentSource: .relay, new: b, source: .direct))
        XCTAssertTrue(RelayE2E.shouldPin(current: a, currentSource: .relay, new: b, source: .qr))
        XCTAssertTrue(RelayE2E.shouldPin(current: a, currentSource: .qr, new: b, source: .direct))
        XCTAssertFalse(RelayE2E.shouldPin(current: nil, currentSource: nil, new: "short", source: .qr))
        XCTAssertEqual(RelayE2E.publicKey(fromCapabilities: ["relay_e2e": ["v": 1, "public_key": a]]), a)
        XCTAssertNil(RelayE2E.publicKey(fromCapabilities: ["relay_e2e": ["v": 2, "public_key": a]]))
        XCTAssertNil(RelayE2E.publicKey(fromCapabilities: [:]))
    }

    func testCredentialRequestsNeverDowngradeOnceVerified() {
        let credential: [(String, String)] = [
            ("POST", "/agents/claude/login"), ("POST", "/agents/claude/login/f1/code"),
            ("GET", "/v1/grok/token"), ("POST", "/screen/session"), ("POST", "/screen/session/s1/ice"),
        ]
        for (method, path) in credential {
            XCTAssertTrue(RelayE2E.carriesCredentials(method: method, path: path), path)
            XCTAssertFalse(RelayE2E.mayFallBackToPlaintext(verified: true, method: method, path: path), path)
            // 从没加密成功过的 Mac(旧版):照旧明文,不然连登录都做不了。
            XCTAssertTrue(RelayE2E.mayFallBackToPlaintext(verified: false, method: method, path: path), path)
        }
        let ordinary: [(String, String)] = [
            ("POST", "/harness/sessions/s1/send"), ("GET", "/harness/sessions"), ("GET", "/agents/claude/auth"),
            ("GET", "/screen/snapshot?max_edge=1280"), ("GET", "/v1/capabilities"), ("DELETE", "/screen/session/s1"),
        ]
        for (method, path) in ordinary {
            XCTAssertTrue(RelayE2E.mayFallBackToPlaintext(verified: true, method: method, path: path), path)
        }
    }

    func testPairPayloadCarriesTheKeyAndOldCodesStillParse() {
        let key = RelayE2E.base64url(Data(repeating: 5, count: 32))
        let raw = #"leoagent-body:v2|{"apiRoot":"https://relay.example/relay/api","machine":"mac","join":"j","exp":9999999999,"e2e":"\#(key)"}"#
        XCTAssertEqual(RelayPairPayload.parse(raw)?.e2e, key)
        XCTAssertEqual(RelayPairPayload.parse(RelayPairPayload.parse(raw)!.encode())?.e2e, key)
        let old = #"leoagent-body:v2|{"apiRoot":"https://relay.example/relay/api","machine":"mac","join":"j","exp":1}"#
        XCTAssertNotNil(RelayPairPayload.parse(old))
        XCTAssertNil(RelayPairPayload.parse(old)?.e2e)
        let junk = #"leoagent-body:v2|{"apiRoot":"https://relay.example/relay/api","machine":"mac","e2e":"nope"}"#
        XCTAssertNil(RelayPairPayload.parse(junk)?.e2e)
    }

    func testShareSendsSealedFirstThenPlaintextWithTheSameRequestId() throws {
        let key = RelayE2E.base64url(macPrivate.publicKey.rawRepresentation)
        var target = ShareMacTarget(sessionId: "s1", title: "t", hostName: "Mac",
                                    relayBase: "https://relay.example/relay/api/m/mac", directBase: nil,
                                    directDeviceId: nil, directExpiresAt: nil, updatedAt: Date())
        XCTAssertEqual(target.requests(text: "秘密", secrets: .init(relayKey: "k", directToken: nil)).count, 1)
        target.relayE2EKey = key
        let requests = target.requests(text: "秘密", secrets: .init(relayKey: "k", directToken: nil), requestId: "rid")
        XCTAssertEqual(requests.map { $0.url?.absoluteString },
                       ["https://relay.example/relay/api/m/mac/e2e", "https://relay.example/relay/api/m/mac/harness/sessions/s1/send"])
        XCTAssertTrue(ShareMacTarget.isSealed(requests[0]))
        XCTAssertFalse(ShareMacTarget.isSealed(requests[1]))
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "X-Leo-Request-Id"), "rid")
        XCTAssertEqual(requests[0].value(forHTTPHeaderField: "X-Leo-Queue"), "1")
        let body = String(data: try XCTUnwrap(requests[0].httpBody), encoding: .utf8) ?? ""
        XCTAssertFalse(body.contains("秘密") || body.contains("send"))
    }
}
