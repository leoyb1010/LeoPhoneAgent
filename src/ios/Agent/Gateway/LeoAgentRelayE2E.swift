//
//  LeoAgentRelayE2E.swift
//  MinisApp
//
//  [e2e] 经中继这一段的端到端加密接线。直连不变;中继腿上有固定的 Mac 公钥就把整个请求
//  (方法、路径、正文、请求编号)封进 POST /e2e 或 GET /e2e/events,Mac 解开后按原样处理。
//  Mac 不支持 / 解不开 → 退回明文并记成「中继:未加密」;能回退,用户不用做任何事。
//  加解密与线格式在 Shared/RelayE2E.swift。
//

import Foundation

extension LeoAgentClient {
    /// 原请求在这台 Mac 中继前缀下的相对路径(含查询);中继自己的接口(/relay/api/queue…)返回 nil,不封也不记状态。
    func machineRelative(_ original: URLRequest) -> String? {
        guard let source = original.url?.absoluteString, let base = harnessBaseURL?.absoluteString else { return nil }
        let prefix = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard source.hasPrefix(prefix + "/") else { return nil }
        return String(source.dropFirst(prefix.count))
    }

    /// 把原请求封成 /e2e(或流的 /e2e/events?v=1&k=&c=);没固定公钥、暂时关着、正文不是 JSON 就返回 nil(走明文)。
    func relaySealed(_ original: URLRequest, stream: Bool = false) -> (request: URLRequest, keys: RelayE2E.Keys)? {
        guard Date() >= relayE2EOffUntil, let macKey = RelayE2E.validKey(relayE2EKey),
              let relative = machineRelative(original), let base = harnessBaseURL,
              let inner = RelayE2E.inner(method: original.httpMethod ?? "GET", path: relative, body: original.httpBody,
                                         requestId: original.value(forHTTPHeaderField: "X-Leo-Request-Id")),
              let sealed = try? RelayE2E.seal(inner: inner, macKey: macKey)
        else { return nil }
        let root = base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        var request = original
        // 新请求只留鉴权、排队、请求编号这类中继要看的头;If-None-Match 之类已在内层路径里。
        for header in ["If-None-Match", "Accept"] { request.setValue(nil, forHTTPHeaderField: header) }
        if stream {
            // base64url 只含 [A-Za-z0-9_-],放进查询不用再编码。
            guard let url = URL(string: root + "/e2e/events?v=1&k=\(sealed.k)&c=\(sealed.c)") else { return nil }
            request.url = url
            request.httpMethod = "GET"
            request.httpBody = nil
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        } else {
            guard let url = URL(string: root + "/e2e"),
                  let body = try? JSONSerialization.data(withJSONObject: sealed.body) else { return nil }
            request.url = url
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return (request, sealed.keys)
    }

    /// routedData 的中继腿。
    func relayData(for original: URLRequest) async throws -> (Data, URLResponse) {
        if let sealed = relaySealed(original) {
            let (data, response) = try await RelayRootRouter.shared.perform(sealed.request) { try await session.data(for: $0) }
            let queued = original.value(forHTTPHeaderField: "X-Leo-Queue") == "1"
            switch RelayE2E.reply(status: (response as? HTTPURLResponse)?.statusCode ?? 0, data: data,
                                  keys: sealed.keys, queued: queued) {
            case .opened(let status, let body):
                await noteRelayE2E(true)
                let headers = ["Content-Type": "application/json"]
                guard let url = original.url,
                      let inner = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: headers)
                else { throw GatewayError.malformedResponse("e2e response") }
                return (body, inner)
            case .passthrough:
                return (data, response)
            case .fallback(let disable):
                if disable { relayE2EOffUntil = Date().addingTimeInterval(600) }
            }
        }
        let (data, response) = try await RelayRootRouter.shared.perform(original) { try await session.data(for: $0) }
        if let relative = machineRelative(original) {
            await noteRelayE2E(false)
            // 明文拿到的 capabilities:还没固定过公钥时作首次信任(扫码 / 直连拿到的会覆盖它)。
            if relative == "/v1/capabilities", (response as? HTTPURLResponse)?.statusCode == 200,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                await pinRelayE2E(from: obj, source: .relay)
            }
        }
        return (data, response)
    }

    func relayPlainBytes(_ original: URLRequest) async throws -> (URLSession.AsyncBytes, URLResponse) {
        let result = try await RelayRootRouter.shared.perform(original, discard: { $0.task.cancel() }) {
            try await session.bytes(for: $0)
        }
        if machineRelative(original) != nil { await noteRelayE2E(false) }
        return result
    }

    /// 解密流。一帧都没等到就结束 = 旧 Mac 不认 /e2e/events(或解不开):退回明文流接着给。
    func e2eLines(_ bytes: URLSession.AsyncBytes, keys: RelayE2E.Keys,
                  fallback original: URLRequest) -> AsyncThrowingStream<String, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var opener = RelayE2E.StreamOpener(keys: keys)
                do {
                    for try await line in bytes.lines {
                        guard line.hasPrefix("data:") else { continue }
                        let raw = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        guard !raw.isEmpty else { continue }
                        // 解不开就抛错断开:中继丢帧 / 换序 / 改内容时,调用方照常按 seq 重连补齐。
                        if let event = try opener.next(raw) {
                            continuation.yield("data: " + event)
                        } else {
                            await self.noteRelayE2E(true)
                        }
                    }
                    if !opener.opened, !Task.isCancelled {
                        self.relayE2EOffUntil = Date().addingTimeInterval(600)
                        let (plain, response) = try await self.relayPlainBytes(original)
                        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                            plain.task.cancel()
                            throw GatewayError.http(status: http.statusCode, message: nil)
                        }
                        for try await line in plain.lines { continuation.yield(line) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel(); bytes.task.cancel() }
        }
    }

    /// 固定 Mac 的中继加密公钥(来源规则见 RelayE2E.shouldPin);主机表是唯一存处,这里只同步本 client 的副本。
    func pinRelayE2E(from capabilities: [String: Any], source: RelayE2E.KeySource) async {
        guard let key = RelayE2E.publicKey(fromCapabilities: capabilities), let hostId else { return }
        if await GatewayHostStore.shared.pinRelayE2EKey(id: hostId, key: key, source: source) {
            relayE2EKey = key
            relayE2EOffUntil = .distantPast
        }
    }

    func noteRelayE2E(_ encrypted: Bool) async {
        guard let hostId else { return }
        await GatewayHostStore.shared.recordRelayE2E(id: hostId, encrypted: encrypted)
    }

    /// 分享扩展发中继时用同一把公钥加密。
    func relayE2EKeyForShare() -> String? { relayE2EKey }
}
