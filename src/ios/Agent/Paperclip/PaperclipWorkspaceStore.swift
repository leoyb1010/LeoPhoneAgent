import Combine
import Foundation
import WebKit

@MainActor
final class PaperclipWorkspaceStore: ObservableObject {
    @Published private(set) var profiles: [PaperclipProfile] = []
    @Published private(set) var selectedID: UUID?
    @Published private(set) var user: PaperclipUser?
    @Published private(set) var companies: [PaperclipCompany] = []
    @Published private(set) var issues: [PaperclipIssue] = []
    @Published private(set) var agents: [PaperclipAgent] = []
    @Published private(set) var busy = false
    @Published var error: String?
    @Published private(set) var companyID = ""
    @Published private(set) var hasMore = false
    private(set) var client: PaperclipClient?
    private var revision = UUID()
    private var nextOffset = 0
    private let defaults: UserDefaults
    private static let profilesKey = "leo.paperclip.profiles.v1"
    private static let selectionKey = "leo.paperclip.selectedProfile.v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.profilesKey),
           let saved = try? JSONDecoder().decode([PaperclipProfile].self, from: data) {
            profiles = saved.compactMap { try? $0.validated() }
        }
        selectedID = defaults.string(forKey: Self.selectionKey).flatMap(UUID.init(uuidString:))
        if !profiles.contains(where: { $0.id == selectedID }) { selectedID = profiles.first?.id }
    }

    var selectedProfile: PaperclipProfile? { profiles.first { $0.id == selectedID } }
    var identityKey: String { "\(selectedID?.uuidString ?? "")/\(companyID)/\(user?.id ?? "")" }

    static func websiteData(for profile: PaperclipProfile) -> WKWebsiteDataStore {
        // 每个不可变配置有独立、设备本地的浏览器容器，不使用系统共享 Cookie。
        WKWebsiteDataStore(forIdentifier: profile.id)
    }

    func add(name: String, address: String) throws {
        let profile = try PaperclipProfile(name: name, address: address)
        profiles.append(profile)
        defaults.set(try JSONEncoder().encode(profiles), forKey: Self.profilesKey)
        select(profile.id)
    }

    func select(_ id: UUID) {
        guard profiles.contains(where: { $0.id == id }) else { return }
        resetConnection()
        selectedID = id
        defaults.set(id.uuidString, forKey: Self.selectionKey)
    }

    private func resetConnection() {
        revision = UUID()
        busy = false
        client?.invalidate()
        client = nil
        user = nil
        companyID = ""
        companies = []
        issues = []
        agents = []
        error = nil
        hasMore = false
        nextOffset = 0
    }

    func clearLogin() async {
        guard let profile = selectedProfile else { return }
        resetConnection()
        busy = true
        let data = Self.websiteData(for: profile)
        await data.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        busy = false
    }

    @discardableResult
    func connect() async -> Bool {
        guard !busy, let profile = selectedProfile else { return false }
        let stamp = revision
        busy = true
        error = nil
        let data = Self.websiteData(for: profile)
        let candidate = PaperclipClient(profile: profile, readCookies: {
            await data.httpCookieStore.allCookies()
        }, saveCookies: { cookies in
            for cookie in cookies { await data.httpCookieStore.setCookie(cookie) }
        })
        do {
            _ = try await candidate.health()
            let session = try await candidate.humanSession()
            let available = try await candidate.companies(userID: session.user.id)
            guard stamp == revision else { return false }
            client = candidate
            user = session.user
            companies = available
            let preferred = defaults.string(forKey: companyKey(profile: profile, user: session.user.id))
            companyID = available.first(where: { $0.id == preferred })?.id ?? available.first?.id ?? ""
            busy = false
            if !companyID.isEmpty { await refresh() }
            return user != nil
        } catch {
            guard stamp == revision else { return false }
            self.error = PaperclipLabels.error(error)
            if error as? PaperclipError == .signedOut || error as? PaperclipError == .identityChanged {
                client?.invalidate()
                client = nil
                user = nil
                issues = []
                agents = []
            }
            busy = false
            return false
        }
    }

    func selectCompany(_ id: String) async {
        guard companies.contains(where: { $0.id == id }), let profile = selectedProfile, let user else { return }
        revision = UUID()
        busy = false
        issues = []
        agents = []
        companyID = id
        defaults.set(id, forKey: companyKey(profile: profile, user: user.id))
        await refresh()
    }

    func refresh(loadMore: Bool = false) async {
        guard !busy, let client, let user, !companyID.isEmpty else { return }
        let stamp = revision
        let company = companyID
        let offset = loadMore ? nextOffset : 0
        busy = true
        do {
            let rows = try await client.issues(companyID: company, userID: user.id, offset: offset)
            let people = try await client.agents(companyID: company, userID: user.id)
            guard stamp == revision else { return }
            if loadMore {
                let known = Set(issues.map(\.id))
                issues += rows.filter { !known.contains($0.id) }
            } else { issues = rows }
            agents = people
            nextOffset = offset + rows.count
            hasMore = rows.count == 100
            error = nil
        } catch {
            guard stamp == revision else { return }
            self.error = PaperclipLabels.error(error)
            // 过期或切换账号后不继续显示旧账号内容。
            if error as? PaperclipError == .signedOut || error as? PaperclipError == .identityChanged {
                self.user = nil
                self.client?.invalidate()
                self.client = nil
                issues = []
                agents = []
            }
        }
        if stamp == revision { busy = false }
    }

    private func companyKey(profile: PaperclipProfile, user: String) -> String {
        "leo.paperclip.company.\(profile.id.uuidString).\(user)"
    }
}
