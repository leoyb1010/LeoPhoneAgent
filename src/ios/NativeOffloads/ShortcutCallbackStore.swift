//
//  ShortcutCallbackStore.swift
//  MinisApp
//
//  [C1] Agent 运行快捷指令后拿回结果。
//
//  `apple-shortcuts run` 每次生成 runId,x-success / x-error / x-cancel 指回
//  leophoneagent://shortcut-result?run=<runId>&status=…。快捷指令 App 回调时
//  若带了 `result` 参数(快捷指令的输出文本)就直接用;没带就读 App Group 里
//  约定的结果文件(快捷指令最后一步「存储文件」):
//    文件 › LeoPhoneAgent › shared › ShortcutResults/<runId>.txt
//    或 ShortcutResults/<快捷指令名>.txt(本次运行开始之后写入的才算)
//  回调到达或 App 回到前台时都会检查文件。以 runId 为键挂起等待,默认 60 秒超时。
//

import Foundation
import UIKit

@objc(LeoShortcutCallbackStore)
final class ShortcutCallbackStore: NSObject, @unchecked Sendable {
    static let callbackHost = "shortcut-result"
    /// 结果文本上限,防止一个大文件塞满工具输出。
    static let maxOutputBytes = 64 * 1024

    struct Callback: Equatable, Sendable {
        enum Status: String, Sendable { case success, error, cancel }
        let runId: String
        let status: Status
        /// 快捷指令 App 在 x-success 上附带的输出文本(可能没有)。
        let result: String?
        let errorMessage: String?
    }

    struct Outcome: Equatable, Sendable {
        enum Status: String, Sendable { case success, error, cancel, timeout }
        let status: Status
        let output: String?
        /// "callback" | "file" | nil
        let source: String?
        let errorMessage: String?
    }

    private final class Pending {
        let name: String
        let startedAt: Date
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: Outcome?
        init(name: String, startedAt: Date) { self.name = name; self.startedAt = startedAt }
    }

    @objc static let shared = ShortcutCallbackStore()

    /// 结果文件目录(App Group 里经「文件」App 可见的 shared 目录)。测试可替换。
    let resultsDirectory: URL
    private let lock = NSLock()
    private var pending: [String: Pending] = [:]
    private var activeObserver: NSObjectProtocol?

    init(resultsDirectory: URL = ShortcutCallbackStore.defaultResultsDirectory, observeAppActive: Bool = true) {
        self.resultsDirectory = resultsDirectory
        super.init()
        if observeAppActive {
            activeObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil
            ) { [weak self] _ in self?.checkResultFiles() }
        }
    }

    deinit {
        if let activeObserver { NotificationCenter.default.removeObserver(activeObserver) }
    }

    /// 与 AIChatViewModel.minisSharedPersistentDir 同一位置(含未签名模拟器的退路)。
    static var defaultResultsDirectory: URL {
        let fm = FileManager.default
        let container = fm.containerURL(forSecurityApplicationGroupIdentifier: SharedContainerStore.appGroupID)
            ?? (fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? fm.temporaryDirectory)
                .appendingPathComponent("LeoPhoneAgent-LocalContainer", isDirectory: true)
        return container
            .appendingPathComponent("MinisFileProvider", isDirectory: true)
            .appendingPathComponent("shared", isDirectory: true)
            .appendingPathComponent("ShortcutResults", isDirectory: true)
    }

    // MARK: - URL

    static func callbackURL(runId: String, status: Callback.Status) -> String {
        "leophoneagent://\(callbackHost)?run=\(runId)&status=\(status.rawValue)"
    }

    /// 解析回调 URL;不是本类回调或 runId 不合法时返回 nil。
    static func parse(_ url: URL) -> Callback? {
        // 生成仍用 leophoneagent://(已发出的 x-callback 都是它);改名后 lobe:// 与 leobot:// 也接受。
        guard ["leophoneagent", "lobe", "leobot"].contains(url.scheme?.lowercased() ?? ""), url.host == callbackHost,
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        func value(_ name: String) -> String? { items.first(where: { $0.name == name })?.value }
        guard let runId = value("run"), isValidRunId(runId) else { return nil }
        let status = value("status").flatMap(Callback.Status.init(rawValue:)) ?? .success
        return Callback(runId: runId, status: status, result: value("result"), errorMessage: value("errorMessage"))
    }

    static func isValidRunId(_ id: String) -> Bool {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-")
        return !id.isEmpty && id.count <= 64 && id.unicodeScalars.allSatisfy(allowed.contains)
    }

    // MARK: - 运行生命周期

    /// 登记一次运行,返回 runId。必须在打开快捷指令 URL 之前调用。
    func begin(name: String, now: Date = Date()) -> String {
        let runId = String(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(12))
        lock.lock(); pending[runId] = Pending(name: name, startedAt: now); lock.unlock()
        return runId
    }

    /// 打开失败等情况下放弃一次运行。
    func cancel(runId: String) {
        lock.lock(); pending[runId] = nil; lock.unlock()
    }

    /// 阻塞等待结果(不要在主线程调用)。超时前最后再看一眼结果文件。
    func wait(runId: String, timeout: TimeInterval) -> Outcome {
        lock.lock(); let entry = pending[runId]; lock.unlock()
        guard let entry else { return Outcome(status: .timeout, output: nil, source: nil, errorMessage: nil) }
        // 墙钟超时:App 被挂起期间时间照样走。
        if entry.semaphore.wait(wallTimeout: .now() + timeout) == .timedOut {
            // 从后台恢复时,回调 URL 可能和超时同时到达,给它一点时间。
            _ = entry.semaphore.wait(timeout: .now() + 2)
        }
        lock.lock()
        pending[runId] = nil
        var outcome = entry.outcome
        lock.unlock()
        if outcome == nil, let text = readResultFile(runId: runId, name: entry.name, startedAt: entry.startedAt) {
            outcome = Outcome(status: .success, output: text, source: "file", errorMessage: nil)
        }
        return outcome ?? Outcome(status: .timeout, output: nil, source: nil, errorMessage: nil)
    }

    /// 回调 URL 到达。返回 true 表示 URL 属于本类(无论是否还有人在等)。
    @discardableResult
    func handle(url: URL) -> Bool {
        guard let callback = Self.parse(url) else { return false }
        deliver(callback)
        return true
    }

    func deliver(_ callback: Callback) {
        lock.lock(); let entry = pending[callback.runId]; lock.unlock()
        guard let entry else { return }
        let outcome: Outcome
        switch callback.status {
        case .success:
            if let result = callback.result, !result.isEmpty {
                outcome = Outcome(status: .success, output: Self.capped(result), source: "callback", errorMessage: nil)
            } else if let text = readResultFile(runId: callback.runId, name: entry.name, startedAt: entry.startedAt) {
                outcome = Outcome(status: .success, output: text, source: "file", errorMessage: nil)
            } else {
                outcome = Outcome(status: .success, output: nil, source: nil, errorMessage: nil)
            }
        case .error:
            outcome = Outcome(status: .error, output: nil, source: nil, errorMessage: callback.errorMessage)
        case .cancel:
            outcome = Outcome(status: .cancel, output: nil, source: nil, errorMessage: nil)
        }
        complete(callback.runId, entry: entry, outcome: outcome)
    }

    /// App 回到前台:用户没经回调直接切回来时,结果文件也能被取到。
    func checkResultFiles() {
        lock.lock(); let snapshot = pending; lock.unlock()
        for (runId, entry) in snapshot {
            guard let text = readResultFile(runId: runId, name: entry.name, startedAt: entry.startedAt) else { continue }
            complete(runId, entry: entry, outcome: Outcome(status: .success, output: text, source: "file", errorMessage: nil))
        }
    }

    private func complete(_ runId: String, entry: Pending, outcome: Outcome) {
        lock.lock()
        guard pending[runId] === entry, entry.outcome == nil else { lock.unlock(); return }
        entry.outcome = outcome
        lock.unlock()
        entry.semaphore.signal()
    }

    // MARK: - 结果文件

    static func resultFileNames(runId: String, name: String) -> [String] {
        let safeName = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        return ["\(runId).txt", "\(safeName).txt"]
    }

    /// `<runId>.txt` 任何时候都算;`<名字>.txt` 只认本次运行开始之后写入的,避免读到上次的旧结果。
    /// 读到即删除,同一结果不会被下次运行复用。
    func readResultFile(runId: String, name: String, startedAt: Date) -> String? {
        let fm = FileManager.default
        for (index, file) in Self.resultFileNames(runId: runId, name: name).enumerated() {
            let url = resultsDirectory.appendingPathComponent(file, isDirectory: false)
            guard fm.fileExists(atPath: url.path) else { continue }
            if index > 0 {
                let modified = (try? fm.attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? .distantPast
                guard modified >= startedAt.addingTimeInterval(-1) else { continue }
            }
            guard let data = try? Data(contentsOf: url) else { continue }
            try? fm.removeItem(at: url)
            let text = String(decoding: data.prefix(Self.maxOutputBytes), as: UTF8.self)
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return nil
    }

    private static func capped(_ text: String) -> String {
        let data = Data(text.utf8)
        guard data.count > maxOutputBytes else { return text }
        return String(decoding: data.prefix(maxOutputBytes), as: UTF8.self)
    }

    // MARK: - Objective-C 入口(ShortcutsOffload.m)

    @objc static func beginRun(name: String) -> String {
        try? FileManager.default.createDirectory(at: shared.resultsDirectory, withIntermediateDirectories: true)
        return shared.begin(name: name)
    }

    @objc static func cancelRun(_ runId: String) { shared.cancel(runId: runId) }

    @objc static func callbackURLString(runId: String, status: String) -> String {
        callbackURL(runId: runId, status: Callback.Status(rawValue: status) ?? .success)
    }

    /// 返回 {status, output?, source?, error?}。
    @objc static func waitForRun(_ runId: String, timeout: TimeInterval) -> NSDictionary {
        let outcome = shared.wait(runId: runId, timeout: timeout)
        let dict = NSMutableDictionary()
        dict["status"] = outcome.status.rawValue
        if let output = outcome.output { dict["output"] = output }
        if let source = outcome.source { dict["source"] = source }
        if let error = outcome.errorMessage { dict["error"] = error }
        return dict
    }
}
