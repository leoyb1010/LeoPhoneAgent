import SwiftUI

// [T-home-simplify-1.41] 首页"输入框优先":底部一条玻璃输入栏就是整个工作台。
//
// 标题栏保留设置、搜索、藏宝阁;输入栏分别提供执行位置和模型入口。
// 工作区、系统快捷与 Mac 入口收进 "/" 面板或执行位置菜单。
//
// 这些视图都返回具体类型、不带泛型参数:ContentView 的类型链已经贴着真机栈上限
// (见 ContentView 里 agentHomeCard 的注释),新组件不能再加深它。

// MARK: - 胶囊标签

struct HomeCapsuleLabel: Equatable {
    var icon: String
    var place: String
    var model: String?
}

// MARK: - 底部输入栏

/// 首页输入框的文字放在一个引用对象里,只有输入栏订阅它:打字不再让整个首页
/// (会话分组、置顶、胶囊标签)跟着每个字重算一遍。
@MainActor
final class HomeDraft: ObservableObject {
    @Published var text = "" {
        didSet {
            guard persistenceURL != nil, text != oldValue else { return }
            needsSave = true
            saveTask?.cancel()
            saveTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 400_000_000)
                guard !Task.isCancelled else { return }
                self?.flushPersistence()
            }
        }
    }
    var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private struct Snapshot: Codable { let text: String; let modelChoice: String? }
    private var persistenceURL: URL?
    private var modelChoice: String?
    private var needsSave = false
    private var saveTask: Task<Void, Never>?

    /// Opt-in: Home search also uses HomeDraft and must remain transient.
    /// This file is deliberately separate from ComposerDrafts/__new_chat__.json.
    func enablePersistence(at url: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("HomeComposerDraft.json")) -> String? {
        guard persistenceURL == nil else { return modelChoice }
        if text.isEmpty, let data = try? Data(contentsOf: url),
           let saved = try? JSONDecoder().decode(Snapshot.self, from: data) {
            text = saved.text
            modelChoice = saved.modelChoice
        }
        persistenceURL = url
        return modelChoice
    }

    func updateModelChoice(_ choice: String?) {
        guard modelChoice != choice else { return }
        modelChoice = choice
        needsSave = true
        flushPersistence()
    }

    /// Background/disappearance flushes the final keystrokes before the debounce.
    func flushPersistence() {
        saveTask?.cancel()
        saveTask = nil
        guard needsSave, let url = persistenceURL else { return }
        do {
            if text.isEmpty, modelChoice == nil {
                if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            } else {
                try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                let data = try JSONEncoder().encode(Snapshot(text: text, modelChoice: modelChoice))
                try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
            needsSave = false
        } catch {
            // Keep dirty state so the next edit/background flush retries the write.
        }
    }
}

/// 首页搜索框:文字放在 HomeDraft 里,只有这一行订阅;每次改动交给首页做防抖搜索,
/// 首页本身等结果回来才重画。
struct HomeSearchField: View {
    @ObservedObject var draft: HomeDraft
    var isFocused: FocusState<Bool>.Binding
    let onChange: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            TextField("搜索对话", text: $draft.text)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused(isFocused)
                .onChange(of: draft.text) { _, _ in onChange() }
            Button("取消") { onCancel() }
                .font(.subheadline)
        }
    }
}

/// 订阅 `HomeDraft` 的那一层:文字变了只重画输入栏。
struct HomeComposerHost: View {
    @ObservedObject var draft: HomeDraft
    var isFocused: FocusState<Bool>.Binding
    let capsule: HomeCapsuleLabel
    let capsuleMenu: AnyView
    var onChooseModel: (() -> Void)? = nil
    let plusMenu: AnyView
    let isBusy: Bool
    let onSubmit: () -> Void
    let onSlash: () -> Void
    let onMic: () -> Void
    let onCancelBusy: () -> Void

    var body: some View {
        HomeComposerBar(
            text: $draft.text,
            isFocused: isFocused,
            capsule: capsule,
            capsuleMenu: capsuleMenu,
            onChooseModel: onChooseModel,
            plusMenu: plusMenu,
            isBusy: isBusy,
            canSend: !isBusy && !draft.trimmed.isEmpty,
            onSubmit: onSubmit,
            onSlash: onSlash,
            onMic: onMic,
            onCancelBusy: onCancelBusy
        )
    }
}

struct HomeComposerBar: View {
    @Binding var text: String
    var isFocused: FocusState<Bool>.Binding
    let capsule: HomeCapsuleLabel
    /// 执行位置菜单,由 ContentView 组装。AnyView 截断类型链。
    let capsuleMenu: AnyView
    var onChooseModel: (() -> Void)? = nil
    /// "+" 菜单内容。
    let plusMenu: AnyView
    let isBusy: Bool
    let canSend: Bool
    let onSubmit: () -> Void
    let onSlash: () -> Void
    let onMic: () -> Void
    let onCancelBusy: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var trimmedEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        executionTarget
                        Spacer(minLength: 0)
                        FullAutoBadge()
                    }
                    modelControl
                }
            } else {
                HStack(spacing: 8) {
                    executionTarget
                    modelControl
                    FullAutoBadge()
                    Spacer(minLength: 0)
                }
            }

            HStack(alignment: .bottom, spacing: 8) {
                Menu { plusMenu } label: {
                    circleIcon("plus", weight: .semibold)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("添加照片或文件"))
                .accessibilityIdentifier("home.add-attachment")

                TextField("问 Leo,或直接说要做的事", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .font(.body)
                    .textFieldStyle(.plain)
                    .focused(isFocused)
                    .submitLabel(.send)
                    .onSubmit { if canSend { onSubmit() } }
                    .padding(.vertical, 7)
                    .frame(minHeight: 36)

                Button(action: onSlash) {
                    circleIcon("slash.circle", weight: .regular)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("动作、技能和 MCP"))
                .accessibilityIdentifier("home.actions")

                trailingButton
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 10)
        .glassEffect(.regular, in: .rect(cornerRadius: 26, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
        .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.15), value: trimmedEmpty)
        .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.15), value: isBusy)
    }

    private var executionTarget: some View {
                Menu { capsuleMenu } label: {
                    HStack(spacing: 5) {
                        Image(systemName: capsule.icon)
                            .font(.system(size: 12, weight: .semibold))
                        Text(capsule.place)
                            .font(.footnote.weight(.semibold))
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 10)
                    .frame(minHeight: 44)
                    .background(Color.primary.opacity(0.06), in: Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("执行位置:\(capsule.place)"))
                .accessibilityHint(Text("选择在哪里执行"))
                .accessibilityIdentifier("home.execution-target")
    }

    @ViewBuilder
    private var modelControl: some View {
                if let onChooseModel {
                    Button(action: onChooseModel) {
                        HStack(spacing: 5) {
                            Text(capsule.model ?? String(localized: "Choose Model"))
                                .font(.footnote.weight(.semibold))
                                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                                .multilineTextAlignment(.leading)
                            Image(systemName: "chevron.down")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 10)
                        .frame(minHeight: 44)
                        .background(Color.primary.opacity(0.06), in: Capsule())
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("选择模型:\(capsule.model ?? String(localized: "默认"))"))
                    .accessibilityIdentifier("home.model-picker")
                }
    }

    @ViewBuilder
    private var trailingButton: some View {
        if isBusy {
            Button(action: onCancelBusy) {
                ZStack {
                    Circle().fill(Color.primary.opacity(0.1))
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12, weight: .bold))
                }
                .frame(width: 36, height: 36)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("停止"))
            .accessibilityIdentifier("home.stop")
        } else if trimmedEmpty {
            Button(action: onMic) {
                circleIcon("mic", weight: .medium)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("语音输入"))
            .accessibilityIdentifier("home.voice-input")
        } else {
            Button(action: onSubmit) {
                ZStack {
                    Circle().fill(canSend ? Color.accentColor : Color.primary.opacity(0.15))
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                }
                .frame(width: 36, height: 36)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel(Text("发送"))
            .accessibilityIdentifier("home.send")
            .transition(.scale(scale: 0.6).combined(with: .opacity))
        }
    }

    private func circleIcon(_ name: String, weight: Font.Weight) -> some View {
        Image(systemName: name)
            .font(.system(size: 17, weight: weight))
            .foregroundStyle(.primary)
            .frame(width: 36, height: 36)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
            .hoverEffect(.highlight)
    }
}

// MARK: - 结果条

/// 本机动作的结果和发送失败的提示,贴在输入栏上方,点 × 收起。
struct HomeResultBanner: View {
    enum Tone { case success, info, error }
    let text: String
    let tone: Tone
    let onClose: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(color)
                .padding(.top, 1)
            Text(text)
                .font(.footnote)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("关闭提示"))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glassEffect(.regular, in: .rect(cornerRadius: 18, style: .continuous))
        .padding(.horizontal, 12)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private var icon: String {
        switch tone {
        case .success: return "checkmark.circle.fill"
        case .info: return "info.circle.fill"
        case .error: return "exclamationmark.circle.fill"
        }
    }

    private var color: Color {
        switch tone {
        case .success: return .green
        case .info: return .secondary
        case .error: return LeoTheme.ColorToken.destructive
        }
    }
}

// MARK: - 空状态

/// 还没有任何对话时:一句话 + 三个可点的起手式,输入栏就在下面。
struct HomeEmptyState: View {
    let hasModel: Bool
    let onSuggestion: (String) -> Void
    let onConnectModel: () -> Void

    /// Also offered under the iPad home workbench composer.
    static let suggestions = ["帮我整理今天要做的事", "打开手电筒", "总结剪贴板里的内容"]

    var body: some View {
        VStack(spacing: 18) {
            Spacer(minLength: 40)
            Image(systemName: "sparkles")
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(.tint)
                .frame(width: 60, height: 60)
                .glassEffect(.regular, in: .circle)
                .accessibilityHidden(true)
            Text("有什么要我做的?")
                .font(.title2.weight(.semibold))
            VStack(spacing: 8) {
                ForEach(Self.suggestions, id: \.self) { item in
                    Button { onSuggestion(item) } label: {
                        Text(item)
                            .font(.subheadline)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 9)
                            .background(Color.primary.opacity(0.06), in: Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            if !hasModel {
                Button("连接模型,处理更复杂的任务", action: onConnectModel)
                    .font(.footnote.weight(.semibold))
                    .padding(.top, 4)
            }
            Spacer(minLength: 120)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
    }
}

// MARK: - "/" 面板

struct HomeAction: Identifiable {
    let id: String
    let title: String
    let icon: String
    let tint: Color
    let run: () -> Void
}

struct HomeSkillItem: Identifiable, Equatable {
    let id: String
    let name: String
    let summary: String
}

/// 动作、一键任务、技能、MCP。常用动作按最近使用排在前面,首屏最多 6 个。
struct HomeActionSheet: View {
    let actions: [HomeAction]
    let quickTasks: [HomeAction]
    let skills: [HomeSkillItem]
    /// 记下选中的动作;面板收起后由 ContentView 在 onDismiss 里执行(状态驱动,不靠固定延迟)。
    let onPick: (HomeAction) -> Void
    let onSkill: (HomeSkillItem) -> Void
    let onManageSkills: () -> Void
    let onManageMCP: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var showAll = false

    private static let usageKey = "home.actionUsage"

    private var ordered: [HomeAction] {
        let usage = UserDefaults.standard.dictionary(forKey: Self.usageKey) as? [String: Double] ?? [:]
        let base = Dictionary(uniqueKeysWithValues: actions.enumerated().map { ($1.id, $0) })
        return actions.sorted { a, b in
            let ua = usage[a.id] ?? 0, ub = usage[b.id] ?? 0
            if ua != ub { return ua > ub }
            return (base[a.id] ?? 0) < (base[b.id] ?? 0)
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    let list = ordered
                    let visible = showAll ? list : Array(list.prefix(6))
                    section("动作") {
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 3), spacing: 10) {
                            ForEach(visible) { action in
                                actionTile(action)
                            }
                        }
                        if list.count > 6 {
                            Button(showAll ? "收起" : "全部 \(list.count) 个动作") {
                                withAnimation(.spring(duration: 0.35, bounce: 0.15)) { showAll.toggle() }
                            }
                            .font(.footnote.weight(.semibold))
                            .padding(.top, 2)
                        }
                    }

                    if !quickTasks.isEmpty {
                        section("一键任务") {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(quickTasks) { task in
                                        Button { perform(task) } label: {
                                            Label(task.title, systemImage: task.icon)
                                                .font(.subheadline.weight(.medium))
                                                .lineLimit(1)
                                                .padding(.horizontal, 12)
                                                .padding(.vertical, 9)
                                                .background(Color.primary.opacity(0.06), in: Capsule())
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }
                        }
                    }

                    section("技能") {
                        if skills.isEmpty {
                            Text("还没有技能。")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        } else {
                            VStack(spacing: 0) {
                                ForEach(skills.prefix(8)) { skill in
                                    Button {
                                        dismiss()
                                        onSkill(skill)
                                    } label: {
                                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                                            Text("/\(skill.name)")
                                                .font(.subheadline.weight(.semibold).monospaced())
                                            Text(skill.summary)
                                                .font(.footnote)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(1)
                                            Spacer(minLength: 0)
                                        }
                                        .padding(.vertical, 10)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    Divider()
                                }
                            }
                        }
                        Button("管理技能") { dismiss(); onManageSkills() }
                            .font(.footnote.weight(.semibold))
                    }

                    section("MCP") {
                        Button { dismiss(); onManageMCP() } label: {
                            Label("MCP 服务器", systemImage: "point.3.connected.trianglepath.dotted")
                                .font(.subheadline)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
            }
            .navigationTitle("能做什么")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
            content()
        }
    }

    private func actionTile(_ action: HomeAction) -> some View {
        Button { perform(action) } label: {
            VStack(spacing: 8) {
                Image(systemName: action.icon)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(action.tint)
                    .frame(height: 24)
                Text(action.title)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 76)
            .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(action.title))
    }

    private func perform(_ action: HomeAction) {
        var usage = UserDefaults.standard.dictionary(forKey: Self.usageKey) as? [String: Double] ?? [:]
        usage[action.id] = Date().timeIntervalSince1970
        UserDefaults.standard.set(usage, forKey: Self.usageKey)
        // 动作本身可能再弹一个面板(终端、浏览器),叠在正在消失的面板上会被系统吞掉,
        // 所以只记下来,等面板真正收起(onDismiss)再执行。
        onPick(action)
        dismiss()
    }
}
