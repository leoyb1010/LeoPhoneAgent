//
//  RelayE2E.swift
//  MinisApp / MinisShare
//
//  [e2e] 经中继的请求端到端加密(src/mac/leophone/docs/specs/leo-link-e2e.md)。
//  每个请求现生成一把 X25519 临时钥匙,和 Mac 的静态公钥做 ECDH,HKDF-SHA256 出两把方向钥匙,
//  ChaCha20-Poly1305 封装;中继只看到 /e2e、/e2e/events 和密文。
//  线格式与 Mac 端 link/relayE2E.ts 逐字节一致:两边测试写死了同一组跨端向量。
//

import CryptoKit
import Foundation

enum RelayE2E {
    static let info = Data("leobot-relay-e2e-v1".utf8)
    static let aadRequest = Data("leobot-e2e-req".utf8)
    static let aadResponse = Data("leobot-e2e-resp".utf8)

    struct Keys {
        /// 手机 → Mac(只用一次,计数 0)。
        let request: SymmetricKey
        /// Mac → 手机(响应计数 0;流的第 n 帧计数 n)。
        let response: SymmetricKey
    }

    /// Mac 公钥从哪来:扫码与直连是可信通道;经中继拿到的只算首次信任,不能顶掉前两种。
    enum KeySource: String, Codable, Sendable {
        case qr, direct, relay
    }

    enum Failure: Error { case badKey, badCiphertext, badFrame }

    // MARK: 密码学

    /// salt = 临时公钥 ‖ Mac 公钥;前 32 字节手机→Mac,后 32 字节 Mac→手机。
    static func deriveKeys(privateKey: Curve25519.KeyAgreement.PrivateKey, peer: Data,
                           ephemeral: Data, mac: Data) throws -> Keys {
        let secret = try privateKey.sharedSecretFromKeyAgreement(with: .init(rawRepresentation: peer))
        let okm = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: ephemeral + mac,
                                                 sharedInfo: info, outputByteCount: 64)
        let bytes = okm.withUnsafeBytes { Data($0) }
        return Keys(request: SymmetricKey(data: bytes.prefix(32)), response: SymmetricKey(data: bytes.suffix(32)))
    }

    /// nonce = 4 个零字节 ‖ 64 位大端计数。
    static func nonce(_ counter: UInt64) -> ChaChaPoly.Nonce {
        var data = Data(count: 4)
        withUnsafeBytes(of: counter.bigEndian) { data.append(contentsOf: $0) }
        return try! ChaChaPoly.Nonce(data: data) // 12 字节,不会失败
    }

    static func seal(_ plaintext: Data, key: SymmetricKey, counter: UInt64, aad: Data) throws -> String {
        let box = try ChaChaPoly.seal(plaintext, using: key, nonce: nonce(counter), authenticating: aad)
        return base64url(box.ciphertext + box.tag)
    }

    static func open(_ sealed: String, key: SymmetricKey, counter: UInt64, aad: Data) throws -> Data {
        guard let data = base64urlDecode(sealed), data.count >= 16 else { throw Failure.badCiphertext }
        let box = try ChaChaPoly.SealedBox(nonce: nonce(counter), ciphertext: data.prefix(data.count - 16),
                                           tag: data.suffix(16))
        return try ChaChaPoly.open(box, using: key, authenticating: aad)
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func base64urlDecode(_ text: String) -> Data? {
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        return Data(base64Encoded: s)
    }

    /// 合法的 Mac 公钥:base64url 的 32 字节。
    static func validKey(_ text: String?) -> Data? {
        guard let text, let raw = base64urlDecode(text), raw.count == 32 else { return nil }
        return raw
    }

    // MARK: 信封

    struct Sealed {
        let keys: Keys
        /// 临时公钥(base64url)。
        let k: String
        /// 内层请求的密文(base64url)。
        let c: String
        var body: [String: Any] { ["v": 1, "k": k, "c": c] }
    }

    static func seal(inner: Data, macKey: Data,
                     ephemeral: Curve25519.KeyAgreement.PrivateKey = .init()) throws -> Sealed {
        let ephemeralPublic = ephemeral.publicKey.rawRepresentation
        let keys = try deriveKeys(privateKey: ephemeral, peer: macKey, ephemeral: ephemeralPublic, mac: macKey)
        return Sealed(keys: keys, k: base64url(ephemeralPublic),
                      c: try seal(inner, key: keys.request, counter: 0, aad: aadRequest))
    }

    /// 内层请求:`{"method","path","body"?,"request_id"?}`。正文不是 JSON 就不封(中继本来也只转 JSON 正文)。
    static func inner(method: String, path: String, body: Data?, requestId: String?) -> Data? {
        var obj: [String: Any] = ["method": method.uppercased(), "path": path]
        if let body, !body.isEmpty {
            guard let parsed = try? JSONSerialization.jsonObject(with: body, options: .fragmentsAllowed) else { return nil }
            obj["body"] = parsed
        }
        if let requestId, !requestId.isEmpty { obj["request_id"] = requestId }
        return try? JSONSerialization.data(withJSONObject: obj)
    }

    /// 经中继回来的东西怎么处理。
    enum Reply: Equatable {
        /// Mac 解开并回了加密响应:内层状态码 + 明文正文。
        case opened(status: Int, body: Data)
        /// 中继自己的回答(离线、排队、钥匙不对……),里面没有业务内容,原样交给调用方。
        case passthrough
        /// 走明文再发一次。`disable` = Mac 不支持或解不开,一段时间内别再试加密。
        case fallback(disable: Bool)
    }

    /// 不解密只分类(分享扩展用):Mac 回的信封 / 要退回明文 / 中继自己的回答。
    static func classify(status: Int, data: Data, queued: Bool) -> Reply {
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        if obj?["v"] as? Int == 1, obj?["c"] is String { return .opened(status: status, body: data) }
        // 旧 Mac 不认 /e2e(白名单外一律 404);新 Mac 解不开(固定的是旧公钥)回 e2e_rejected。
        if status == 404 || (obj?["error"] as? [String: Any])?["code"] as? String == "e2e_rejected" {
            return .fallback(disable: true)
        }
        // 旧中继不给 /e2e 排队:Mac 离线时退回明文排队,保住「离线也能发」(新中继会直接排这个信封)。
        if queued && status == 502 { return .fallback(disable: false) }
        return .passthrough
    }

    static func reply(status: Int, data: Data, keys: Keys, queued: Bool) -> Reply {
        let kind = classify(status: status, data: data, queued: queued)
        guard case .opened = kind,
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let c = obj["c"] as? String,
              let plain = try? open(c, key: keys.response, counter: 0, aad: aadResponse),
              let inner = try? JSONSerialization.jsonObject(with: plain) as? [String: Any],
              let innerStatus = inner["status"] as? Int
        else {
            // 信封在、却解不开:中继改了内容。退回明文(写操作有请求编号,Mac 按回执去重,不会做两次)。
            if case .opened = kind { return .fallback(disable: true) }
            return kind
        }
        let body = (try? JSONSerialization.data(withJSONObject: inner["body"] ?? NSNull(), options: .fragmentsAllowed))
            ?? Data("null".utf8)
        return .opened(status: innerStatus, body: body)
    }

    /// 流:第 0 帧必须是 `{"type":"e2e.open"}`,之后每帧计数依次 +1。
    /// 中继丢帧、换序或改内容,下一帧就解不开 —— 调用方断开重连,按 seq 续传补齐。
    struct StreamOpener {
        let keys: Keys
        private(set) var counter: UInt64 = 0
        var opened: Bool { counter > 0 }

        init(keys: Keys) { self.keys = keys }

        /// 一条 data 行的正文 → 事件明文;握手帧返回 nil。
        mutating func next(_ raw: String) throws -> String? {
            guard let frame = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
                  frame["v"] as? Int == 1, let c = frame["c"] as? String,
                  let plain = try? RelayE2E.open(c, key: keys.response, counter: counter, aad: aadResponse),
                  let text = String(data: plain, encoding: .utf8)
            else { throw Failure.badFrame }
            defer { counter += 1 }
            if counter == 0 {
                guard (try? JSONSerialization.jsonObject(with: plain) as? [String: Any])?["type"] as? String == "e2e.open"
                else { throw Failure.badFrame }
                return nil
            }
            return text
        }
    }

    // MARK: 公钥固定

    /// capabilities 里的 `relay_e2e.public_key`。
    static func publicKey(fromCapabilities obj: [String: Any]) -> String? {
        guard let e2e = obj["relay_e2e"] as? [String: Any], e2e["v"] as? Int == 1,
              let key = e2e["public_key"] as? String, validKey(key) != nil else { return nil }
        return key
    }

    /// 要不要换成这把新钥匙:经中继拿到的只能填空(首次信任);一旦固定,只有扫码 / 直连能替换。
    /// 中继要是能替换,主动攻击者只要先逼手机降级、再递一把自己的钥匙就把首次信任作废了;
    /// Mac 换钥匙很少见,直连一次或重扫一次就恢复。
    static func shouldPin(current: String?, currentSource: KeySource?, new: String, source: KeySource) -> Bool {
        guard validKey(new) != nil, new != current else { return false }
        return current == nil || source != .relay
    }

    /// 携带凭据的请求(外部 agent 登录的 API key / 授权码、Grok token、看屏会话的 SDP):
    /// 这台 Mac 加密成功过一次后,这类请求不再退回明文中继。
    static func carriesCredentials(method: String, path: String) -> Bool {
        let route = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? path
        if route == "/v1/grok/token" { return true }
        guard method.uppercased() == "POST" else { return false }
        return (route.hasPrefix("/agents/") && route.contains("/login")) || route.hasPrefix("/screen/session")
    }

    /// 这条请求能不能退回明文中继:加密成功过的 Mac,带凭据的不能;其余照旧可以(方便为先)。
    static func mayFallBackToPlaintext(verified: Bool, method: String, path: String) -> Bool {
        !(verified && carriesCredentials(method: method, path: path))
    }
}
