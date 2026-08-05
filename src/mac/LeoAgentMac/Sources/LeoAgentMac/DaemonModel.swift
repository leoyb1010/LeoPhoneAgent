//
//  DaemonModel.swift
//  LeoAgentMac
//
//  Reads the local daemon and the agent engine beside it, and can restart the
//  daemon through launchd.
//
//  Everything here talks to 127.0.0.1 only. The app is an operator console for
//  THIS machine; anything remote is the phone's job.
//

import Foundation
import AppKit

struct HarnessRow: Identifiable, Hashable {
    let id: String
    let name: String
    let cwd: String
    let status: String
    let waitingForApproval: Bool
}

@MainActor
final class DaemonModel: ObservableObject {
    @Published private(set) var isUp = false
    @Published private(set) var engineUp = false
    @Published private(set) var version = "—"
    @Published private(set) var harnessNames: [String] = []
    @Published private(set) var sessions: [HarnessRow] = []
    @Published private(set) var lastError: String?
    @Published var selected: String?

    private let daemonURL = URL(string: "http://127.0.0.1:8646")!
    private let engineURL = URL(string: "http://127.0.0.1:8642")!
    private let serviceLabel = "com.leoyuan.leoagent"
    private var polling = false

    var waitingCount: Int { sessions.filter(\.waitingForApproval).count }

    var menuBarSymbol: String {
        if waitingCount > 0 { return "exclamationmark.triangle.fill" }
        return isUp ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle"
    }

    /// The key is written by the daemon's own setup, readable only by this
    /// user. Reading it from disk keeps it out of the app bundle and out of
    /// any argument list that would show up in `ps`.
    private var accessKey: String? {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".leoagent/key")
        return (try? String(contentsOf: path, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func startPolling() async {
        guard !polling else { return }
        polling = true
        // defer, not a trailing assignment: this loop exits by cancellation
        // (closing the menu popover or the window cancels its .task), and
        // without resetting the flag the very first close would wedge the
        // guard above forever — every panel would then show state frozen at
        // the last refresh, with no error and no way back short of relaunching.
        defer { polling = false }
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(nanoseconds: 4_000_000_000)
        }
    }

    func refresh() async {
        // Sequential, not `async let`: the latter would hand a non-Sendable
        // dictionary across an isolation boundary, and on a 4-second poll the
        // parallelism buys nothing.
        let daemonInfo = await probe(daemonURL.appendingPathComponent("health"))
        let engineInfo = await probe(engineURL.appendingPathComponent("health"))

        isUp = daemonInfo != nil
        engineUp = engineInfo != nil
        version = daemonInfo?["version"] as? String ?? "—"

        guard isUp, let key = accessKey, !key.isEmpty else {
            harnessNames = []
            sessions = []
            if isUp { lastError = "找不到访问密钥 ~/.leoagent/key" }
            return
        }
        lastError = nil
        await loadCapabilities(key: key)
        await loadSessions(key: key)
    }

    private func probe(_ url: URL) async -> [String: Any]? {
        var req = URLRequest(url: url)
        req.timeoutInterval = 4
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func authed(_ path: String, key: String) async -> [String: Any]? {
        var req = URLRequest(url: daemonURL.appendingPathComponent(path))
        req.timeoutInterval = 6
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse, http.statusCode == 200 else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func loadCapabilities(key: String) async {
        guard let obj = await authed("v1/capabilities", key: key) else { return }
        let rows = obj["harnesses"] as? [[String: Any]] ?? []
        harnessNames = rows.compactMap { $0["name"] as? String }
    }

    private func loadSessions(key: String) async {
        guard let obj = await authed("harness/sessions", key: key) else { return }
        let rows = obj["sessions"] as? [[String: Any]] ?? []
        sessions = rows.compactMap { row in
            guard let id = row["session_id"] as? String else { return nil }
            return HarnessRow(
                id: id,
                name: row["name"] as? String ?? "session",
                cwd: row["cwd"] as? String ?? "",
                status: row["status"] as? String ?? "",
                waitingForApproval: row["waiting_for_approval"] as? Bool ?? false)
        }
    }

    /// Bounce the launchd job. `kickstart -k` restarts a running job and starts
    /// a stopped one, so one command covers both buttons.
    /// async so the launchctl round-trip never blocks the main thread: this
    /// type is @MainActor, and a launchd bounce that hangs would freeze the
    /// menu bar itself.
    func restartDaemon() async {
        let uid = getuid()
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["kickstart", "-k", "gui/\(uid)/\(serviceLabel)"]
        let pipe = Pipe()
        task.standardError = pipe
        do {
            try task.run()
            await Task.detached { task.waitUntilExit() }.value
            if task.terminationStatus != 0 {
                let err = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                lastError = "launchctl 失败 (\(task.terminationStatus)) \(err.prefix(120))"
            } else {
                lastError = nil
            }
        } catch {
            lastError = error.localizedDescription
        }
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        await refresh()
    }
}
