//
//  MacAutomationsView.swift
//  MinisApp
//
//  [C3] 远程机器页里一台 Mac 的「定时任务」:列出 Mac 上的自动化(计划、开关、上次 / 下次运行),
//  开关、立即运行、删除、从模板新建。数据每次现拉 `GET /automations`(Mac 是唯一所有者,手机不存副本),
//  请求走 LeoAgentClient.automationCall,解析在 MacAutomationLogic(编进 MinisTests)。
//  契约:src/mac/leophone/docs/specs/leo-link-automations.md。
//

import SwiftUI

struct MacAutomationsView: View {
    let host: GatewayHost

    private enum Phase: Equatable {
        case loading
        /// 整条 /automations 都 404:Mac 上的 LeoBot 太旧。
        case unsupported
        case failed(String)
        case loaded
    }

    @State private var phase: Phase = .loading
    @State private var items: [MacAutomationLogic.Summary] = []
    /// nil = 这台 Mac 没有模板接口(或还没问到),按钮不出现。
    @State private var templates: [MacAutomationLogic.Template]?
    /// 正在操作的任务 id(那一行的按钮先置灰,别连点)。
    @State private var busy: Set<String> = []
    @State private var pendingDelete: MacAutomationLogic.Summary?
    @State private var pendingTemplate: MacAutomationLogic.Template?
    @State private var actionError: String?
    @State private var notice: String?
    /// 开关拨了、Mac 还没回:先按拨的显示,免得开关弹回去再跳过来。
    @State private var enabledOverride: [String: Bool] = [:]

    var body: some View {
        content
            .navigationTitle(Text("定时任务"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let templates, !templates.isEmpty, phase == .loaded {
                    ToolbarItem(placement: .primaryAction) {
                        Menu {
                            ForEach(templates) { template in
                                Button {
                                    pendingTemplate = template
                                } label: {
                                    if let schedule = template.scheduleText {
                                        Text(verbatim: "\(template.name) · \(schedule)")
                                    } else {
                                        Text(verbatim: template.name)
                                    }
                                }
                            }
                        } label: {
                            Label("从模板新建", systemImage: "plus")
                        }
                        .accessibilityIdentifier("macAutomations.fromTemplate")
                    }
                }
            }
            .confirmationDialog(Text("删除这个定时任务？"),
                                isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                                titleVisibility: .visible, presenting: pendingDelete) { item in
                Button("删除", role: .destructive) { Task { await delete(item) } }
                Button("取消", role: .cancel) {}
            } message: { item in
                Text("「\(item.name)」会从 \(host.name) 上删掉，之后不再运行。运行记录留在 Mac 上。")
            }
            .confirmationDialog(Text("新建定时任务"),
                                isPresented: Binding(get: { pendingTemplate != nil }, set: { if !$0 { pendingTemplate = nil } }),
                                titleVisibility: .visible, presenting: pendingTemplate) { template in
                Button("在 \(host.name) 上新建") { Task { await create(from: template) } }
                Button("取消", role: .cancel) {}
            } message: { template in
                Text(verbatim: [template.name, template.scheduleText, template.detail].compactMap { $0 }.joined(separator: "\n"))
            }
            .alert(Text("没办成"), isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
                Button("好", role: .cancel) {}
            } message: { Text(actionError ?? "") }
            .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            VStack(spacing: LeoTheme.Spacing.md) {
                ProgressView()
                Text("正在读 Mac 上的定时任务…")
                    .font(.subheadline)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .unsupported:
            ContentUnavailableView {
                Label("需要 Mac 1.14.0+", systemImage: "clock.badge.exclamationmark")
            } description: {
                Text("这台 Mac 上的 LeoBot 版本较旧，还没有定时任务。把 Mac 端更新到 1.14.0 或更新版本再试。")
            }
        case .failed(let message):
            ContentUnavailableView {
                Label("连不上 Mac", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("重试") { Task { await load() } }
                    .buttonStyle(.borderedProminent)
            }
        case .loaded:
            if items.isEmpty {
                ContentUnavailableView {
                    Label("还没有定时任务", systemImage: "clock")
                } description: {
                    Text("在对话里跟 LeoBot 说「每天早上 8 点帮我…」，它会在这台 Mac 上建好；手机锁屏、离线时照样按时运行。")
                } actions: {
                    Button("刷新") { Task { await load() } }
                }
            } else {
                List {
                    if let notice {
                        Section {
                            Label(notice, systemImage: "checkmark.circle")
                                .font(.footnote)
                                .foregroundStyle(LeoTheme.ColorToken.success)
                        }
                    }
                    Section {
                        ForEach(items) { item in row(item) }
                    } footer: {
                        Text("计划按 Mac 的本地时间运行，Mac 要开着 LeoBot。跑完的结果会推到这台手机。")
                    }
                }
                .refreshable { await load() }
            }
        }
    }

    private func row(_ item: MacAutomationLogic.Summary) -> some View {
        VStack(alignment: .leading, spacing: LeoTheme.Spacing.xs) {
            HStack(alignment: .top, spacing: LeoTheme.Spacing.sm) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.name)
                        .font(.system(size: 16, weight: .medium))
                        .lineLimit(2)
                    if !item.scheduleText.isEmpty {
                        Label(item.scheduleText, systemImage: "calendar.badge.clock")
                            .font(.caption)
                            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    }
                    lastRunLine(item)
                    if item.enabled, !item.isFinished, let next = item.nextRunAt {
                        HStack(spacing: 4) {
                            Text("下次")
                            Text(next, format: .dateTime.month().day().hour().minute())
                        }
                        .font(.caption)
                        .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    } else if item.isFinished {
                        Text("已完成，不会再运行")
                            .font(.caption)
                            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    }
                }
                Spacer(minLength: 0)
                Toggle(isOn: Binding(get: { enabledOverride[item.id] ?? item.enabled }, set: { on in Task { await setEnabled(item, on) } })) {
                    Text("启用")
                }
                .labelsHidden()
                .disabled(busy.contains(item.id) || item.isFinished)
                .accessibilityLabel(Text("启用「\(item.name)」"))
            }
            HStack(spacing: 18) {
                Button {
                    Task { await runNow(item) }
                } label: {
                    Label("立即运行", systemImage: "play.fill")
                        .font(.caption.weight(.medium))
                }
                .buttonStyle(.borderless)
                .accessibilityIdentifier("macAutomations.run")
                Button(role: .destructive) {
                    pendingDelete = item
                } label: {
                    Label("删除", systemImage: "trash")
                        .font(.caption.weight(.medium))
                }
                .buttonStyle(.borderless)
                if busy.contains(item.id) { ProgressView().controlSize(.small) }
            }
            .disabled(busy.contains(item.id))
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func lastRunLine(_ item: MacAutomationLogic.Summary) -> some View {
        if let status = item.lastRunStatus {
            let look = Self.statusLook(status)
            HStack(spacing: 4) {
                Image(systemName: look.symbol).foregroundStyle(look.color)
                Text(look.label)
                if let at = item.lastRunAt {
                    Text("·")
                    Text(at, format: .relative(presentation: .named))
                }
            }
            .font(.caption)
            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
        } else {
            Text("还没运行过")
                .font(.caption)
                .foregroundStyle(LeoTheme.ColorToken.tertiaryText)
        }
    }

    private static func statusLook(_ status: String) -> (label: LocalizedStringKey, symbol: String, color: Color) {
        switch status {
        case "succeeded": return ("上次成功", "checkmark.circle.fill", LeoTheme.ColorToken.success)
        case "running": return ("正在运行", "circle.dotted", LeoTheme.ColorToken.accent)
        case "pending": return ("等待派发", "clock", LeoTheme.ColorToken.secondaryText)
        case "stopped": return ("上次已停止", "stop.circle", LeoTheme.ColorToken.warning)
        case "skipped": return ("上次错过", "forward.circle", LeoTheme.ColorToken.warning)
        case "dispatch_failed": return ("上次没派发出去", "exclamationmark.circle", LeoTheme.ColorToken.destructive)
        default: return ("上次失败", "xmark.circle.fill", LeoTheme.ColorToken.destructive)
        }
    }

    // MARK: - Actions

    private var client: LeoAgentClient? { GatewayHostStore.shared.client(for: host) }

    private func load() async {
        guard let client else {
            phase = .failed(AppLocalized("这台 Mac 还没有访问密钥：在「连接信息」里填好再试。"))
            return
        }
        if items.isEmpty { phase = .loading }
        do {
            let raw = try await client.automationCall(try MacAutomationLogic.request(action: .list, args: [:]))
            items = MacAutomationLogic.summaries(fromList: try? JSONSerialization.jsonObject(with: Data(raw.utf8)))
            phase = .loaded
        } catch {
            if LeoAgentClient.isNotFound(error) {
                phase = .unsupported
                return
            }
            // 刷新失败但手上已有列表:留着列表,弹一句。
            if phase == .loaded { actionError = LeoAgentClient.describeHarnessFeatureError(error) } else {
                phase = .failed(LeoAgentClient.describeHarnessFeatureError(error))
            }
            return
        }
        // 模板是 Mac 新加的接口:404 / 出错就不显示按钮,不影响列表。
        if templates == nil, let raw = try? await client.automationCall(MacAutomationLogic.templatesRequest) {
            templates = MacAutomationLogic.templates(from: try? JSONSerialization.jsonObject(with: Data(raw.utf8)))
        }
    }

    private func perform(_ item: MacAutomationLogic.Summary?, _ request: () throws -> MacAutomationLogic.Request,
                         done: String? = nil) async {
        guard let client else { return }
        if let item { busy.insert(item.id) }
        defer { if let item { busy.remove(item.id) } }
        do {
            _ = try await client.automationCall(try request())
            notice = done
            await load()
        } catch {
            if LeoAgentClient.isNotFound(error) {
                actionError = AppLocalized("这台 Mac 上已经没有这个任务了，列表已刷新。")
                await load()
            } else {
                actionError = LeoAgentClient.describeHarnessFeatureError(error)
            }
        }
    }

    private func setEnabled(_ item: MacAutomationLogic.Summary, _ on: Bool) async {
        enabledOverride[item.id] = on
        defer { enabledOverride[item.id] = nil }
        await perform(item, { try MacAutomationLogic.request(action: .update, args: ["id": item.id, "enabled": on]) })
    }

    private func runNow(_ item: MacAutomationLogic.Summary) async {
        await perform(item, { try MacAutomationLogic.request(action: .run, args: ["id": item.id]) },
                      done: AppLocalized("「\(item.name)」已开始运行，跑完会通知你。"))
    }

    private func delete(_ item: MacAutomationLogic.Summary) async {
        await perform(item, { try MacAutomationLogic.request(action: .delete, args: ["id": item.id]) })
    }

    private func create(from template: MacAutomationLogic.Template) async {
        await perform(nil, { template.create }, done: AppLocalized("已新建「\(template.name)」。"))
    }
}
