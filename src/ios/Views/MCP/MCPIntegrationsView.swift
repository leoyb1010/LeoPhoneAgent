//
//  MCPIntegrationsView.swift
//  MinisApp
//
//  Management screen for MCP (Model Context Protocol) servers. Mirrors
//  SkillsManagementView: a list of servers with status dot + name + transport,
//  swipe-to-delete, and a toolbar "+" menu offering form-add or JSON-import.
//

import SwiftUI

struct MCPIntegrationsView: View {
    /// [T-mcp-oauth-deeplink] When set (leophoneagent://settings/mcp-servers/<id>),
    /// open this server's edit form on appear — that's where the Authorize
    /// button lives. Unknown/deleted ids fall through to the plain list.
    var initialEditServerId: String? = nil

    @ObservedObject private var store = MCPStore.shared

    @State private var editingServer: MCPServerConfig?
    @State private var showAddForm = false
    @State private var showJSONImport = false
    /// [T-mcp-catalog] Recommended-servers catalog sheet + the template the
    /// user picked from it. Presenting the form is deferred to the catalog
    /// sheet's onDismiss so the two sheets never race.
    @State private var showCatalog = false
    @State private var pendingCatalogPrefill: MCPServerConfig?
    @State private var catalogPrefill: MCPServerConfig?
    /// [T-mcp-tools-refresh] Server whose tools sheet is presented.
    @State private var toolsServer: MCPServerConfig?
    /// One-shot consumption of initialEditServerId.
    @State private var consumedInitialEdit = false

    var body: some View {
        List {
            if store.servers.isEmpty {
                emptyState
            } else {
                ForEach(store.servers) { server in
                    Button {
                        editingServer = server
                    } label: {
                        row(for: server)
                    }
                    .buttonStyle(.plain)
                    // [T-mcp-tools-refresh] Per-server tools entry: opens the
                    // sheet, which force-reconnects + re-pulls tools/list.
                    .contextMenu {
                        Button {
                            toolsServer = server
                        } label: {
                            Label(String(localized: "Refresh Tools"), systemImage: "arrow.clockwise")
                        }
                    }
                    .swipeActions(edge: .leading, allowsFullSwipe: false) {
                        Button {
                            toolsServer = server
                        } label: {
                            Label(String(localized: "Tools"), systemImage: "arrow.clockwise")
                        }
                        .tint(.blue)
                    }
                }
                .onDelete { offsets in
                    let ids = offsets.map { store.servers[$0].id }
                    for id in ids { store.delete(id: id) }
                }
            }
        }
        .navigationTitle(Text("MCP Integrations"))
        .navigationBarTitleDisplayMode(.inline)
        // [T-ios-mcp-list-reload-on-appear] Re-read servers.json on appear so a
        // server written by leophoneagent-mcp-cli after launch shows up without an app
        // restart (MCPStore.load() otherwise runs only in init). Mirrors
        // SkillsManagementView's .onAppear { store.reload() }.
        .onAppear {
            store.load()
            // [T-mcp-oauth-deeplink] Deep-linked server → open its edit form
            // once. Slightly deferred so the sheet presents after the push
            // animation settles (presenting during the transition is dropped
            // by UIKit on some iOS versions).
            if !consumedInitialEdit, let id = initialEditServerId {
                consumedInitialEdit = true
                if let server = store.servers.first(where: { $0.id == id }) {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                        editingServer = server
                    }
                }
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        showCatalog = true
                    } label: {
                        Label(String(localized: "Recommended MCP directory"), systemImage: "square.grid.2x2")
                    }
                    Button {
                        showAddForm = true
                    } label: {
                        Label(String(localized: "Add Server"), systemImage: "plus")
                    }
                    Button {
                        showJSONImport = true
                    } label: {
                        Label(String(localized: "Import JSON"), systemImage: "doc.text")
                    }
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showAddForm) {
            MCPFormSheet(server: nil)
        }
        .sheet(isPresented: $showCatalog, onDismiss: {
            if let pending = pendingCatalogPrefill {
                pendingCatalogPrefill = nil
                catalogPrefill = pending
            }
        }) {
            MCPCatalogSheet { config in
                pendingCatalogPrefill = config
                showCatalog = false
            }
        }
        .sheet(item: $catalogPrefill) { config in
            MCPFormSheet(server: nil, prefill: config)
        }
        .sheet(item: $editingServer) { server in
            MCPFormSheet(server: server)
        }
        .sheet(isPresented: $showJSONImport) {
            MCPJSONImportSheet()
        }
        .sheet(item: $toolsServer) { server in
            MCPToolsSheet(serverName: server.id)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "puzzlepiece.extension")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
            Text("No MCP Servers")
                .font(.headline)
            Text("Add an MCP server to give the agent extra tools. Tap + to add one manually or import a JSON config.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            // Custom-drawn capsule instead of .borderedProminent: system
            // button styles render unreliably inside a clear-background
            // List row (stretched/ghosted fill on iOS 26 glass material).
            Button {
                showCatalog = true
            } label: {
                Label(String(localized: "Browse recommended MCP servers"), systemImage: "square.grid.2x2")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color.accentColor, in: Capsule())
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
        .listRowBackground(Color.clear)
    }

    private func row(for server: MCPServerConfig) -> some View {
        HStack(spacing: 12) {
            Circle()
                .fill(server.enabled ? Color.green : Color.gray)
                .frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 3) {
                Text(server.id)
                    .font(.body)
                    .foregroundStyle(.primary)
                HStack(spacing: 4) {
                    Text(server.isHTTP ? "HTTP" : (server.isSTDIO ? "STDIO" : "—"))
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(server.transportSummary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

// MARK: - Recommended catalog [T-mcp-catalog]

/// One entry in the built-in recommended MCP directory. Entries with a
/// `config` have an officially hosted remote endpoint (SSE / streamable
/// HTTP) — tapping them prefills the add form; the placeholder key in the
/// URL must be replaced with the user's own. Entries without a `config`
/// are stdio/partner services that can't run hosted on iOS; tapping opens
/// their docs page instead.
private struct MCPCatalogEntry: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let category: String
    let docsURL: String
    let config: MCPServerConfig?
    /// [T-mcp-catalog-note-vs-hint] Human setup instructions, shown in the app
    /// only. These used to be written into `config.note`, which
    /// `MCPStore.systemPromptSnippet` injects verbatim into EVERY session's
    /// system prompt — so "replace YOUR_KEY with a key from lbs.amap.com" was
    /// being told to the model, which can neither do it nor needs to know.
    /// `note` now describes the server's capability, which is what the model
    /// actually uses to decide whether to call it.
    let setupHint: String

    static func hosted(
        id: String, title: String, subtitle: String, category: String,
        url: String, headers: [String: String]? = nil, note: String, setupHint: String, docsURL: String
    ) -> MCPCatalogEntry {
        var config = MCPServerConfig(id: id, enabled: true)
        config.url = url
        config.headers = headers
        config.note = note
        return MCPCatalogEntry(
            id: id, title: title, subtitle: subtitle,
            category: category, docsURL: docsURL, config: config,
            setupHint: setupHint
        )
    }

    static func docsOnly(
        id: String, title: String, subtitle: String, category: String, docsURL: String
    ) -> MCPCatalogEntry {
        MCPCatalogEntry(
            id: id, title: title, subtitle: subtitle,
            category: category, docsURL: docsURL, config: nil,
            setupHint: ""
        )
    }

    /// Curated from 国内热门 MCP/Skill 清单 (2026-07).
    ///
    /// [T-mcp-catalog-transport] Hosted URLs point at each vendor's
    /// **streamable-HTTP** endpoint (`/mcp`), verified 2026-07-29 by POSTing a
    /// real `initialize` to each one. They used to point at the legacy
    /// two-endpoint `/sse` transport, which neither the native client nor the
    /// in-guest CLI implements — both only ever POST — so every hosted entry
    /// was unusable as shipped.
    ///
    /// [T-mcp-catalog-secrets] Credentials are referenced as `$$NAME`
    /// environment variables rather than pasted into the URL. servers.json
    /// syncs through iCloud, and the app's own system prompt tells the agent to
    /// use `$$NAME` for exactly this reason; the catalog now follows its own
    /// advice. NativeMCPClient and the CLI both expand these at call time.
    static let all: [MCPCatalogEntry] = [
        .hosted(
            id: "amap-maps",
            title: "高德地图",
            subtitle: "地理编码、路径规划、POI 搜索、天气、距离测量",
            category: "地图与出行",
            url: "https://mcp.amap.com/mcp?key=$$AMAP_KEY",
            note: "Amap (Gaode) Maps: geocoding, reverse geocoding, POI search, driving/walking/transit routing, weather, distance.",
            setupHint: "需要一个高德开放平台「Web 服务」类型的 Key（lbs.amap.com 免费申请）。把它存成名为 AMAP_KEY 的环境变量（设置 → 环境变量），URL 里的 $$AMAP_KEY 会在调用时自动替换。",
            docsURL: "https://lbs.amap.com/api/mcp-server/summary"
        ),
        .hosted(
            id: "baidu-map",
            title: "百度地图",
            subtitle: "地理编码、地点检索、路线规划、天气",
            category: "地图与出行",
            url: "https://mcp.map.baidu.com/mcp?ak=$$BAIDU_MAP_AK",
            note: "Baidu Maps: geocoding, place search, route planning, weather.",
            setupHint: "需要百度地图开放平台的服务端 AK，并在控制台为该 AK 开通 MCP 服务。把它存成名为 BAIDU_MAP_AK 的环境变量。",
            docsURL: "https://github.com/baidu-maps/mcp/blob/main/README_zh.md"
        ),
        .hosted(
            id: "tencent-map",
            title: "腾讯位置服务",
            subtitle: "地址解析、地点搜索、路线规划、IP 定位、天气",
            category: "地图与出行",
            url: "https://mcp.map.qq.com/mcp?key=$$TENCENT_MAP_KEY",
            note: "Tencent Maps: address resolution, place search, route planning, IP location, weather.",
            setupHint: "需要在 lbs.qq.com 创建并开通 WebService API 的 Key。把它存成名为 TENCENT_MAP_KEY 的环境变量。",
            docsURL: "https://lbs.qq.com/service/MCPServer/MCPServerGuide/userGuide"
        ),
        .hosted(
            id: "zhipu-web-search",
            title: "智谱联网搜索",
            subtitle: "聚合多引擎实时搜索，为大模型优化的结果格式",
            category: "搜索与资讯",
            // [T-zhipu-auth-carrier] The streamable-HTTP endpoint authenticates
            // with a Bearer REQUEST HEADER; `?Authorization=` in the query is
            // the legacy /sse form and 401s here.
            url: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
            headers: ["Authorization": "Bearer $$ZHIPU_API_KEY"],
            note: "Zhipu Web Search: aggregated real-time search across engines, results formatted for LLMs.",
            setupHint: "需要 open.bigmodel.cn 的 API Key。把它存成名为 ZHIPU_API_KEY 的环境变量。",
            docsURL: "https://docs.bigmodel.cn/cn/coding-plan/mcp/search-mcp-server"
        ),
        .docsOnly(
            id: "hotnews",
            title: "HotNews 全网热榜",
            subtitle: "聚合国内多平台实时热榜（社区实现，stdio 需自行部署）",
            category: "搜索与资讯",
            docsURL: "https://github.com/wopal/mcp-server-hotnews"
        ),
        .docsOnly(
            id: "alipay",
            title: "支付宝 MCP",
            subtitle: "支付、订单查询、退款（npm stdio，需 Node 环境）",
            category: "支付与生活",
            docsURL: "https://opendocs.alipay.com/open/0go80l"
        ),
        .docsOnly(
            id: "kuaidi100",
            title: "快递100",
            subtitle: "快递轨迹查询、运费时效预估",
            category: "支付与生活",
            docsURL: "https://github.com/kuaidi100/mcp-server"
        ),
        .docsOnly(
            id: "12306",
            title: "12306 车票查询",
            subtitle: "车票查询、过滤、中转方案（社区实现）",
            category: "地图与出行",
            docsURL: "https://github.com/pmq20/12306-mcp"
        ),
        .docsOnly(
            id: "didi",
            title: "滴滴出行",
            subtitle: "叫车、预约出行、订单查询（需在滴滴开放平台接入）",
            category: "地图与出行",
            docsURL: "https://mcp.didichuxing.com/"
        ),
        .docsOnly(
            id: "feishu",
            title: "飞书",
            subtitle: "消息、文档、待办、日程、审批（开放平台接入）",
            category: "办公协作",
            docsURL: "https://open.feishu.cn/?lang=zh-CN"
        ),
        .docsOnly(
            id: "dingtalk",
            title: "钉钉",
            subtitle: "消息、待办、日程、审批流（开放平台接入）",
            category: "办公协作",
            docsURL: "https://open.dingtalk.com/"
        ),
        .docsOnly(
            id: "qweather",
            title: "和风天气",
            subtitle: "中国城市天气、气象预警、7 天预报",
            category: "搜索与资讯",
            docsURL: "https://github.com/qweather/mcp-server"
        ),
    ]
}

/// Built-in directory of popular Chinese MCP servers. Hosted entries prefill
/// the add-server form via `onPick`; docs-only entries open Safari.
private struct MCPCatalogSheet: View {
    let onPick: (MCPServerConfig) -> Void
    @Environment(\.dismiss) private var dismiss

    private var categories: [String] {
        var seen = Set<String>()
        return MCPCatalogEntry.all.map(\.category).filter { seen.insert($0).inserted }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(categories, id: \.self) { category in
                    Section {
                        ForEach(MCPCatalogEntry.all.filter { $0.category == category }) { entry in
                            Button {
                                if let config = entry.config {
                                    onPick(config)
                                } else if let url = URL(string: entry.docsURL) {
                                    UIApplication.shared.open(url)
                                }
                            } label: {
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 3) {
                                        HStack(spacing: 6) {
                                            Text(entry.title)
                                                .font(.body)
                                                .foregroundStyle(.primary)
                                            if entry.config != nil {
                                                Text("Hosted")
                                                    .font(.caption2.weight(.semibold))
                                                    .padding(.horizontal, 5)
                                                    .padding(.vertical, 1.5)
                                                    .background(Color.green.opacity(0.15), in: Capsule())
                                                    .foregroundStyle(.green)
                                            }
                                        }
                                        Text(entry.subtitle)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(2)
                                        if !entry.setupHint.isEmpty {
                                            Label(entry.setupHint, systemImage: "key.fill")
                                                .font(.caption2)
                                                .foregroundStyle(.orange)
                                                .lineLimit(3)
                                        }
                                    }
                                    Spacer()
                                    Image(systemName: entry.config != nil
                                          ? "plus.circle.fill"
                                          : "arrow.up.right.square")
                                        .foregroundStyle(entry.config != nil ? Color.accentColor : Color.secondary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    } header: {
                        Text(category)
                    } footer: {
                        // Attach the explainer to the LAST real section — an
                        // empty Section carrying only a footer renders as a
                        // broken-looking hollow box on iOS 26.
                        if category == categories.last {
                            Text("Hosted entries prefill the add form. $$NAME in the URL is an environment-variable reference — create the variable under Settings → Environment Variables first; it is substituted at call time so the key never enters the synced config file. Other entries are stdio or platform services; tap to open their docs.")
                        }
                    }
                }
            }
            .navigationTitle(Text("Recommended MCP"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(String(localized: "Done")) { dismiss() }
                }
            }
        }
    }
}

// MARK: - Tools sheet [T-mcp-tools-refresh]

/// Live tools list for one server. Opening the sheet performs a FORCED
/// refresh (`leophoneagent-mcp-cli refresh <name>`: evict the daemon session,
/// re-handshake, tools/list) so tools the remote server added after we first
/// connected appear without restarting the app or the daemon.
struct MCPToolsSheet: View {
    let serverName: String
    @Environment(\.dismiss) private var dismiss
    @State private var tools: [MCPStore.MCPToolInfo] = []
    @State private var isLoading = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            List {
                if isLoading {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Reconnecting and fetching tools…")
                            .foregroundStyle(.secondary)
                    }
                } else if let errorText {
                    Section {
                        Label {
                            Text(errorText)
                        } icon: {
                            Image(systemName: "exclamationmark.triangle")
                                .foregroundStyle(.orange)
                        }
                        .font(.subheadline)
                    }
                } else if tools.isEmpty {
                    Text("The server reported no tools.")
                        .foregroundStyle(.secondary)
                } else {
                    Section(footer: Text("Fetched live from the server just now.")) {
                        ForEach(tools) { tool in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(tool.name)
                                    .font(.body.monospaced())
                                if !tool.description.isEmpty {
                                    Text(tool.description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(3)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(Text(verbatim: serverName))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { await refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(isLoading)
                    .accessibilityLabel(Text("Refresh tools"))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(String(localized: "Done")) { dismiss() }
                }
            }
            .task { await refresh() }
        }
    }

    private func refresh() async {
        isLoading = true
        errorText = nil
        do {
            tools = try await MCPStore.shared.refreshTools(server: serverName)
        } catch {
            errorText = error.localizedDescription
        }
        isLoading = false
    }
}
