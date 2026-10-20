//
//  MacScreenSnapshotClient.swift
//  MinisApp
//
//  [WP-50 R0] 看 Mac 的屏幕:LeoAgentClient 取一帧(直连优先、中继兜底,路线由
//  routedData 决定),MacScreenPoller 在前台按 1.5 s 轮询,退到后台 / 离开页面就停。
//  线格式与错误码在 Shared/MacScreenSnapshot.swift。
//

import Foundation
import UIKit

extension LeoAgentClient {
    /// 取一帧。永远不抛:连不上、旧 Mac 没有这个接口,都归成 `.failure`,由轮询器按错误退避。
    func screenSnapshot(maxEdge: Int = MacScreenSnapshotWire.defaultMaxEdge,
                        quality: Double = MacScreenSnapshotWire.defaultQuality,
                        display: String? = nil, etag: String? = nil) async -> MacScreenSnapshotWire.Result {
        do {
            var req = try request(MacScreenSnapshotWire.requestPath(maxEdge: maxEdge, quality: quality,
                                                                    display: display, etag: etag),
                                  service: .harness)
            req.setValue(nil, forHTTPHeaderField: "Content-Type")
            req.setValue("image/jpeg, application/json", forHTTPHeaderField: "Accept")
            if let etag, !etag.isEmpty { req.setValue(etag, forHTTPHeaderField: "If-None-Match") }
            req.cachePolicy = .reloadIgnoringLocalCacheData
            req.timeoutInterval = 10
            let (data, response) = try await routedData(for: req)
            guard let http = response as? HTTPURLResponse else {
                return .failure(MacScreenError(status: 0, code: "malformed", message: "不是 HTTP 响应"))
            }
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields {
                if let key = key as? String { headers[key] = "\(value)" }
            }
            return MacScreenSnapshotWire.parse(status: http.statusCode, headers: headers, data: data)
        } catch is CancellationError {
            return .failure(MacScreenError(status: 0, code: "cancelled"))
        } catch GatewayError.harnessNotConfigured {
            return .failure(MacScreenError(status: 0, code: "not_supported"))
        } catch {
            return .failure(MacScreenError(status: 0, code: "offline", message: error.localizedDescription))
        }
    }
}

/// 哪几台 Mac 能看屏:开着的、配了 harness 地址的 LeoBot Mac。
@MainActor
enum MacScreenHosts {
    static var candidates: [GatewayHost] {
        GatewayHostStore.shared.hosts.filter { $0.isEnabled && $0.harnessBase != nil && !$0.isAndroidBody }
    }

    static func client(hostId: String?) -> (host: GatewayHost, client: LeoAgentClient)? {
        let all = candidates
        let host = all.first { $0.id == hostId } ?? all.first
        guard let host, let client = GatewayHostStore.shared.client(for: host) else { return nil }
        return (host, client)
    }
}

@MainActor
final class MacScreenPoller: ObservableObject {
    @Published private(set) var image: UIImage?
    @Published private(set) var frame: MacScreenFrame?
    @Published private(set) var error: MacScreenError?
    /// 最近一次拿到 Mac 回应(新帧或「没变」)的时间。
    @Published private(set) var lastUpdate: Date?
    @Published private(set) var isPolling = false

    var client: LeoAgentClient? {
        didSet { if client !== oldValue { reset(); if viewers > 0 { start() } } }
    }
    private var task: Task<Void, Never>?
    private var attempt = MacScreenAttempt()
    private var maxEdge = MacScreenSnapshotWire.defaultMaxEdge

    init(client: LeoAgentClient? = nil) {
        self.client = client
    }

    func start() {
        guard task == nil, let client else { return }
        isPolling = true
        let id = attempt.begin()
        task = Task { [weak self] in
            var failures = 0
            while !Task.isCancelled {
                guard let self else { return }
                let started = Date()
                let result = await client.screenSnapshot(maxEdge: self.maxEdge, etag: self.frame?.etag)
                if Task.isCancelled { break }
                await self.apply(result, attempt: id)
                if case .failure(let error) = result {
                    failures += 1
                    if let smaller = MacScreenPollPolicy.reducedEdge(after: error, current: self.maxEdge) {
                        self.maxEdge = smaller
                    }
                } else { failures = 0 }
                guard let delay = MacScreenPollPolicy.nextDelay(after: result, consecutiveFailures: failures) else { break }
                let wait = max(delay, MacScreenPollPolicy.minimumInterval) - Date().timeIntervalSince(started)
                if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
            }
            // 只有还是这一次启动才收尾:stop() 后马上 start(),旧任务退出时不能把新任务的 task / isPolling 清掉。
            guard let self, self.attempt.isCurrent(id) else { return }
            self.task = nil
            self.isPolling = false
        }
    }

    func stop() {
        attempt.invalidate()
        task?.cancel()
        task = nil
        isPolling = false
    }

    /// Views on screen that want frames. Polling runs while at least one holds it.
    private var viewers = 0

    func acquire() {
        viewers += 1
        start()
    }

    func release() {
        viewers = max(0, viewers - 1)
        if viewers == 0 { stop() }
    }

    /// 「重试」:要人处理的错误(开关没开、旧 Mac)停了轮询,处理完点一下接着来。
    func retry() {
        error = nil
        stop()
        if viewers > 0 { start() }
    }

    private func reset() {
        stop()
        image = nil
        frame = nil
        error = nil
        lastUpdate = nil
        maxEdge = MacScreenSnapshotWire.defaultMaxEdge
    }

    private func apply(_ result: MacScreenSnapshotWire.Result, attempt id: Int) async {
        switch result {
        case .frame(let next):
            // Decode off the main thread: a 1280 px JPEG decoded lazily on first draw hitches scrolling.
            let decoded = await Task.detached(priority: .userInitiated) {
                UIImage(data: next.jpeg)?.preparingForDisplay()
            }.value
            // 解码期间换了 Mac / 停了:这帧是旧那次的,丢掉。
            guard attempt.isCurrent(id) else { return }
            guard let decoded else {
                error = MacScreenError(status: 200, code: "malformed", message: "画面解码失败")
                return
            }
            image = decoded
            frame = next
            error = nil
            lastUpdate = Date()
        case .notModified:
            error = nil
            lastUpdate = Date()
        case .failure(let failure):
            if failure.code == "cancelled" { return }
            error = failure
        }
    }
}

/// [WP-50 R0] 手表的「Mac 画面」页:iPhone 代取一张 ≤400 px 的小图,经 WatchConnectivity 回过去。
@MainActor
enum MacScreenWatchProvider {
    /// 上次合适的尺寸。画面太大降一档后记住,之后每 3 s 只取一次,不再每次先取大图再取小图。
    /// ponytail: 只降不升(进程内有效),Mac 画面变简单后也停在小档;要升档再加按字节数回调。
    private static var edge = MacScreenSnapshotWire.watchMaxEdge
    private static var quality = MacScreenSnapshotWire.watchQuality
    private static let smallEdge = 320
    private static let smallQuality = 0.35

    static func thumbnail(etag: String?) async -> [String: Any] {
        guard let target = MacScreenHosts.client(hostId: nil) else {
            return [MacScreenWatchRelay.errorKey: "iPhone 上还没有连好的 Mac"]
        }
        var result = await target.client.screenSnapshot(maxEdge: edge, quality: quality, etag: etag)
        if case .frame(let frame) = result, frame.jpeg.count > MacScreenSnapshotWire.watchMaxBytes {
            if edge > smallEdge {
                // Over the WatchConnectivity message size: drop to the small size once and keep it.
                edge = smallEdge
                quality = smallQuality
                result = await target.client.screenSnapshot(maxEdge: edge, quality: quality)
            }
            if case .frame(let small) = result, small.jpeg.count > MacScreenSnapshotWire.watchMaxBytes {
                result = .failure(MacScreenError(status: 200, code: "frame_too_large"))
            }
        }
        return MacScreenWatchRelay.reply(result, host: target.host.name)
    }
}
