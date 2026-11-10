//
//  BrainSpaceView.swift
//  LeoPhoneAgent
//
//  [brain-space] 第二大脑空间:标题栏按钮全屏打开,底部五个入口与网页版手机底栏一致
//  (今日 / 影像 / 问 / 家人 / 资料),右上角上传和管家。低频页面在应用内用网页打开。
//  配色沿用第二大脑:黑白灰 + 蓝,不用 LeoBot 的青绿。
//

import LocalAuthentication
import SwiftUI
import WebKit

enum BrainTheme {
    static let accent = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.541, green: 0.643, blue: 1.0, alpha: 1)
            : UIColor(red: 0.239, green: 0.361, blue: 0.812, alpha: 1)
    })
}

enum BrainSpaceTab: Hashable { case today, media, ask, family, library }

struct BrainAskSeed: Equatable, Identifiable {
    let id = UUID()
    var question: String
    var fileIds: [String] = []
    var answerId: String?
}

@MainActor
final class BrainSpaceModel: ObservableObject {
    @Published var manifest: BrainSpaceManifest?
    @Published var setupError: String?
    /// The typed cause behind `setupError`, so the setup page can offer the right next step.
    @Published var setupCause: BrainSpaceError?
    @Published var tab: BrainSpaceTab = .today
    @Published var askSeed: BrainAskSeed?
    @Published var mediaPerson: BrainFamilyMember?
    @Published var showSteward = false
    @Published var showUpload = false
    @Published var showPhoneCollections = false
    @Published var showWorkspace = false
    @Published var webPage: BrainWebPage?
    @Published var toast: String?
    @Published var stewardNeedsYou = false
    var close: () -> Void = {}
    private var loadGeneration = 0

    func load() async {
        loadGeneration &+= 1
        let generation = loadGeneration
        setupError = nil
        setupCause = nil
        BrainStore.shared.importProvisionFileIfPresent()
        let revision = BrainStore.shared.connectionRevision
        do {
            let m = try await BrainSpaceAPI.shared.manifest()
            guard !Task.isCancelled, generation == loadGeneration, revision == BrainStore.shared.connectionRevision else { return }
            manifest = m
            if !m.app { setupCause = .noAppScope; setupError = BrainSpaceError.noAppScope.errorDescription }
        } catch {
            guard !Task.isCancelled, generation == loadGeneration, revision == BrainStore.shared.connectionRevision else { return }
            setupCause = error as? BrainSpaceError
            setupError = error.localizedDescription
        }
    }

    func ask(_ question: String, fileIds: [String] = []) {
        askSeed = BrainAskSeed(question: question, fileIds: fileIds)
        tab = .ask
    }

    func openAnswer(_ id: String, question: String) {
        askSeed = BrainAskSeed(question: question, answerId: id)
        tab = .ask
    }

    func photos(of member: BrainFamilyMember) {
        mediaPerson = member
        tab = .media
    }

    func say(_ text: String) {
        toast = text
        Task { try? await Task.sleep(for: .seconds(2)); if toast == text { toast = nil } }
    }
}

struct BrainWebPage: Identifiable, Hashable {
    let id: String   // hash route of the web UI, e.g. devices
    let title: String
}

struct BrainSpaceView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = BrainSpaceModel()
    @ObservedObject private var store = BrainStore.shared

    var body: some View {
        Group {
            if let err = model.setupError {
                BrainSpaceSetupView(message: err)
            } else if model.manifest == nil {
                ProgressView("正在连接资料库…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                tabs
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemGroupedBackground).ignoresSafeArea())
        .environmentObject(model)
        .tint(BrainTheme.accent)
        .task(id: store.connectionRevision) {
            model.close = { dismiss() }
            model.manifest = nil
            await model.load()
        }
        .sheet(isPresented: $model.showSteward) { BrainStewardSheet().environmentObject(model).tint(BrainTheme.accent) }
        .sheet(isPresented: $model.showUpload) { BrainUploadSheet().environmentObject(model).tint(BrainTheme.accent) }
        .sheet(isPresented: $model.showPhoneCollections) { CollectionsView(onClose: { model.showPhoneCollections = false }, phoneOnly: true) }
        .sheet(isPresented: $model.showWorkspace) { NavigationStack { BrainWorkspaceView(onClose: { model.showWorkspace = false }) }.tint(BrainTheme.accent) }
        .sheet(item: $model.webPage) { page in BrainWebSheet(page: page).tint(BrainTheme.accent) }
        .overlay(alignment: .top) {
            if let t = model.toast {
                Text(t).font(.subheadline).padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.thinMaterial, in: Capsule()).padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityAddTraits(.isStaticText)
            }
        }
        .animation(.snappy, value: model.toast)
    }

    private var tabs: some View {
        TabView(selection: $model.tab) {
            Tab("今日", systemImage: "calendar", value: BrainSpaceTab.today) {
                NavigationStack { BrainTodayView().brainChrome("今日") }
            }
            Tab("影像", systemImage: "photo.on.rectangle", value: BrainSpaceTab.media) {
                NavigationStack { BrainMediaView().brainChrome("影像") }
            }
            Tab("问", systemImage: "bubble.left.and.text.bubble.right", value: BrainSpaceTab.ask) {
                NavigationStack { BrainAskView().brainChrome("问") }
            }
            Tab("家人", systemImage: "heart", value: BrainSpaceTab.family) {
                NavigationStack { BrainFamilyView().brainChrome("家人") }
            }
            Tab("资料", systemImage: "doc.text", value: BrainSpaceTab.library) {
                NavigationStack { BrainLibraryView().brainChrome("资料") }
            }
        }
    }
}

private struct BrainChrome: ViewModifier {
    @EnvironmentObject private var model: BrainSpaceModel
    let title: String

    func body(content: Content) -> some View {
        content
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { model.close() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel(Text("关闭第二大脑"))
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if model.manifest?.can.upload == true {
                        Button { model.showUpload = true } label: { Image(systemName: "square.and.arrow.up") }
                            .accessibilityLabel(Text("发到资料库"))
                    }
                    Button { model.showSteward = true } label: {
                        Image(systemName: model.stewardNeedsYou ? "bell.badge" : "bell")
                    }
                    .accessibilityLabel(Text("管家"))
                }
            }
    }
}

extension View {
    func brainChrome(_ title: String) -> some View { modifier(BrainChrome(title: title)) }
}

struct BrainSpaceSetupView: View {
    @EnvironmentObject private var model: BrainSpaceModel
    let message: String
    @State private var showAdvanced = false

    private var needsConnection: Bool { model.setupCause == .notConfigured }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    Image(systemName: needsConnection ? "link.badge.plus" : "externaldrive.badge.questionmark")
                        .font(.largeTitle).imageScale(.large).foregroundStyle(.secondary)
                    Text(needsConnection ? "连接第二大脑" : "第二大脑暂时打不开").font(.title3.weight(.semibold))
                    Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    if needsConnection {
                        NavigationLink { BrainSettingsView() } label: {
                            Text("去连接").frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum)
                        }
                        .buttonStyle(.borderedProminent)
                    } else {
                        Button { Task { await model.load() } } label: {
                            Text("重试").frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum)
                        }
                        .buttonStyle(.borderedProminent)
                        NavigationLink("查看连接设置") { BrainSettingsView() }
                            .frame(minHeight: LeoTheme.TouchTarget.minimum)
                    }
                    Button { model.showPhoneCollections = true } label: {
                        VStack(spacing: 2) {
                            Text("打开手机收藏")
                            Text("存在这台手机上,不连第二大脑也能用").font(.caption).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum)
                    }
                    .buttonStyle(.bordered)
                    if let hint = model.setupCause?.advancedHint {
                        DisclosureGroup("高级", isExpanded: $showAdvanced) {
                            Text(hint).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
                        }
                        .font(.subheadline)
                    }
                }
                .padding(32)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { model.close() } label: { Image(systemName: "xmark") }.accessibilityLabel(Text("关闭"))
                }
            }
        }
    }
}

// MARK: - Shared pieces

struct BrainRemoteImage: View {
    let path: String
    var contentMode: ContentMode = .fill
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        // The placeholder decides the size; the photo fills it (overlay never grows the frame).
        Rectangle().fill(Color(.secondarySystemFill))
            .overlay {
                if let image {
                    Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
                } else if failed {
                    Image(systemName: "photo").foregroundStyle(.tertiary)
                }
            }
            .clipped()
        .task(id: path) {
            image = await BrainImageCache.shared.image(path)
            failed = image == nil
        }
    }
}

struct BrainAvatar: View {
    let path: String?
    let name: String
    var size: CGFloat = 44

    var body: some View {
        Group {
            if let path {
                BrainRemoteImage(path: path)
            } else {
                Text(String(name.prefix(1))).font(.headline).frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(.secondarySystemFill))
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .accessibilityLabel(Text(name))
    }
}

struct BrainSection<Content: View>: View {
    let title: String
    var action: (String, () -> Void)?
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.title3.weight(.semibold))
                Spacer()
                if let action { Button(action.0, action: action.1).font(.subheadline) }
            }
            content
        }
    }
}

struct BrainErrorRow: View {
    let message: String
    var retry: (() -> Void)?

    var body: some View {
        VStack(spacing: 8) {
            Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if let retry { Button("重试", action: retry).font(.subheadline) }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 24)
    }
}

enum BrainAuth {
    /// Face ID (or passcode) before anything that shares, approves or changes data on the mini.
    static func confirm(_ reason: String) async -> Bool {
        let ctx = LAContext()
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &err) else { return true }
        return (try? await ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}

// MARK: - Web fallback (devices, protection, system…)

struct BrainWebSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = BrainStore.shared
    let page: BrainWebPage
    /// The cookie, the base it is scoped to and the connection it belongs to come from one configuration snapshot.
    @State private var session: (session: BrainWebSession, base: URL, revision: Int)?
    @State private var error: String?
    @State private var loadToken: UUID?

    var body: some View {
        NavigationStack {
            Group {
                if let session, session.revision == store.connectionRevision {
                    BrainWebView(base: session.base, route: page.id, session: session.session)
                        // A new connection gets a new web view (and a new private store), never the old one.
                        .id(session.revision)
                } else if let error {
                    BrainErrorRow(message: error) { Task { await load() } }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(page.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
        .task(id: store.connectionRevision) { await load() }
        .onDisappear { loadToken = nil; session = nil }
    }

    private func load() async {
        let token = UUID()
        loadToken = token
        let revision = store.connectionRevision
        session = nil
        error = nil
        do {
            let cfg = try BrainSpaceAPI.shared.config()
            let s = try await BrainSpaceAPI.shared.webSession(config: cfg)
            guard !Task.isCancelled, loadToken == token, revision == store.connectionRevision else { return }
            session = (s, cfg.endpoint.base, revision)
        } catch {
            guard !Task.isCancelled, loadToken == token, revision == store.connectionRevision, !(error is CancellationError) else { return }
            self.error = error.localizedDescription
        }
    }
}

private struct BrainWebView: UIViewRepresentable {
    final class Coordinator { var active = true }
    func makeCoordinator() -> Coordinator { Coordinator() }
    let base: URL
    let route: String
    let session: BrainWebSession

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        // Private, in-memory store owned by this web view only. The archive login cookie never enters the default
        // store the Agent browser and chat previews share, and it is gone when the sheet closes. The Agent's own
        // cookies are untouched (this store never touches the default one).
        cfg.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.allowsBackForwardNavigationGestures = true
        let https = base.scheme?.lowercased() == "https"
        var props: [HTTPCookiePropertyKey: Any] = [
            .name: session.cookie, .value: session.value, .domain: base.host() ?? "", .path: "/",
            .expires: Date(timeIntervalSince1970: session.expiresAt),
            // Same attributes the web UI's own login sets: not readable from page scripts.
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
        ]
        if https { props[.secure] = "TRUE" }
        // route: a web UI hash page (devices) or an absolute path (/api/shares/preview/<token>).
        let target = URL(string: base.absoluteString + (route.hasPrefix("/") ? route : "/#" + route)) ?? base
        if let cookie = HTTPCookie(properties: props) {
            let coordinator = context.coordinator
            cfg.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak web, weak coordinator] in
                guard let web, coordinator?.active == true else { return }
                web.load(URLRequest(url: target))
            }
        } else {
            web.load(URLRequest(url: target))
        }
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        coordinator.active = false
        web.stopLoading()
        // Drop the private store's cookies now instead of waiting for the store to be released.
        let store = web.configuration.websiteDataStore
        store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {}
    }
}
