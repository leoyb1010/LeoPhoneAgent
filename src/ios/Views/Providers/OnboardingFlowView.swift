//
//  OnboardingFlowView.swift
//  MinisApp
//
//  [G2] 首启新手引导:① 连接模型 ② 配对 Mac(可跳过)③ 派第一个任务。
//  · 首启、没配好模型、看过「本次更新」后自动出现(OnboardingHost);跳过或走完都记为完成,
//    配好模型后也记为完成,以后不再自动出现。
//  · 设置 → 数据与关于 →「新手引导」、首页空状态都能再进来。
//  · 每一步都复用现成入口:添加服务商 / 模型库 / 默认模型分组(OnboardingModelSelectionView)、
//    远程机器的扫码配对(GatewayPairing.scan)。
//

import SwiftUI

extension Notification.Name {
    /// 首页空状态等处:请求打开新手引导(全屏)。
    static let onboardingRequested = Notification.Name("leo.onboardingRequested")
    /// 设置里走完引导选了示例任务:userInfo["prompt"] 放进首页输入框并收起设置。
    static let onboardingPrefillRequested = Notification.Name("leo.onboardingPrefillRequested")
}

struct OnboardingFlowView: View {
    enum Presentation { case cover, pushed }

    let presentation: Presentation
    /// 结束。prefill 非 nil:把示例任务放进首页输入框。
    let onFinish: (_ prefill: String?) -> Void

    @ObservedObject private var providerStore = ProviderConfigStore.shared
    @ObservedObject private var gatewayStore = GatewayHostStore.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss

    @State private var step: OnboardingGate.Step
    @State private var showAddProvider = false
    @State private var showModelLibrary = false
    @State private var showDefaultModels = false
    @State private var pairResult: String?
    @State private var pairing = false

    init(presentation: Presentation, onFinish: @escaping (_ prefill: String?) -> Void) {
        self.presentation = presentation
        self.onFinish = onFinish
        _step = State(initialValue: OnboardingGate.initialStep())
    }

    static var samplePrompt: String { AppLocalized("帮我把今天要做的事列成清单，按轻重缓急排好，再提醒我先做哪一件") }

    private var hasModel: Bool {
        providerStore.modelEntries.contains { ModelSwitcher.isAvailable($0, store: providerStore) }
    }

    private var hasMac: Bool {
        _ = gatewayStore.hosts.count   // 订阅变化;判定沿用 MacFleetFeature
        return MacFleetFeature.hasPairedMac()
    }

    var body: some View {
        VStack(spacing: 0) {
            progress
                .padding(.top, LeoTheme.Spacing.md)
            ScrollView {
                stepContent
                    .id(step)
                    .transition(stepTransition)
                    .frame(maxWidth: 520)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, LeoTheme.Spacing.xl)
                    .padding(.top, LeoTheme.Spacing.xl)
            }
            .scrollBounceBehavior(.basedOnSize)
            actions
                .frame(maxWidth: 520)
                .padding(.horizontal, LeoTheme.Spacing.xl)
                .padding(.bottom, LeoTheme.Spacing.lg)
        }
        .background(LeoTheme.ColorToken.groupedBackground.ignoresSafeArea())
        .navigationTitle(Text("新手引导"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if presentation == .cover {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("跳过") { finish(prefill: nil) }
                        .accessibilityIdentifier("onboarding.skip")
                }
            }
        }
        .sheet(isPresented: $showAddProvider) { NavigationStack { AddProviderView() } }
        .sheet(isPresented: $showModelLibrary) { NavigationStack { ModelLibraryView() } }
        .sheet(isPresented: $showDefaultModels) { NavigationStack { OnboardingModelSelectionView() } }
    }

    // MARK: - Pieces

    private var stepTransition: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity),
                                              removal: .move(edge: .leading).combined(with: .opacity))
    }

    private var progress: some View {
        HStack(spacing: LeoTheme.Spacing.xs) {
            ForEach(OnboardingGate.Step.allCases, id: \.self) { s in
                Capsule()
                    .fill(s.rawValue <= step.rawValue ? LeoTheme.ColorToken.accent : LeoTheme.ColorToken.separator)
                    .frame(width: s == step ? 24 : 8, height: 8)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("第 \(step.rawValue + 1) 步，共 \(OnboardingGate.Step.allCases.count) 步"))
    }

    @ViewBuilder
    private var stepContent: some View {
        VStack(spacing: LeoTheme.Spacing.lg) {
            Image(systemName: symbol)
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(LeoTheme.ColorToken.accent)
                .frame(width: 72, height: 72)
                .background(LeoTheme.ColorToken.accentSoft, in: Circle())
                .accessibilityHidden(true)
            VStack(spacing: LeoTheme.Spacing.sm) {
                Text(title)
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text(message)
                    .font(.body)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            stepDetail
        }
    }

    private var symbol: String {
        switch step {
        case .model: return "cpu"
        case .mac: return "macbook.and.iphone"
        case .firstTask: return "paperplane"
        }
    }

    private var title: LocalizedStringKey {
        switch step {
        case .model: return "连接模型"
        case .mac: return "配对 Mac"
        case .firstTask: return "派第一个任务"
        }
    }

    private var message: LocalizedStringKey {
        switch step {
        case .model: return "LeoBot 靠大模型思考和干活。添加一个模型服务商（填 API Key 或登录账号）就能开始。"
        case .mac: return "在 Mac 上的 LeoBot 打开配对二维码，用手机扫一下，就能把任务派给 Mac 去做。没有 Mac 可以跳过。"
        case .firstTask: return "试试让 LeoBot 帮你做件事。下面这句会放进首页输入框，改一改再发送。"
        }
    }

    @ViewBuilder
    private var stepDetail: some View {
        switch step {
        case .model:
            if hasModel {
                statusRow(Text("模型已连接"), done: true)
            }
        case .mac:
            if hasMac {
                statusRow(Text("已配对 Mac"), done: true)
            }
            if let pairResult {
                Text(pairResult)
                    .font(.footnote)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    .multilineTextAlignment(.center)
            }
        case .firstTask:
            Text(Self.samplePrompt)
                .font(.callout)
                .foregroundStyle(LeoTheme.ColorToken.primaryText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(LeoTheme.Spacing.md)
                .background(LeoTheme.ColorToken.surface,
                            in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
            if !hasModel {
                Text("还没连接模型：发送时会先请你连接。")
                    .font(.footnote)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            }
        }
    }

    private func statusRow(_ text: Text, done: Bool) -> some View {
        Label { text } icon: {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(done ? LeoTheme.ColorToken.success : LeoTheme.ColorToken.tertiaryText)
        }
        .font(.subheadline.weight(.semibold))
        .padding(.horizontal, LeoTheme.Spacing.md)
        .padding(.vertical, LeoTheme.Spacing.xs)
        .background(LeoTheme.ColorToken.surface, in: Capsule())
    }

    // MARK: - Actions

    @ViewBuilder
    private var actions: some View {
        VStack(spacing: LeoTheme.Spacing.xs) {
            switch step {
            case .model:
                if hasModel {
                    primary("下一步", id: "onboarding.next") { advance() }
                    if providerStore.defaultPrimaryGroupId == nil {
                        secondary("选择默认模型") { showDefaultModels = true }
                    }
                } else {
                    primary("添加模型服务商", id: "onboarding.model.add") {
                        if providerStore.instances.isEmpty { showAddProvider = true } else { showModelLibrary = true }
                    }
                    secondary("稍后再说", id: "onboarding.model.later") { advance() }
                }
            case .mac:
                if hasMac {
                    primary("下一步", id: "onboarding.next") { advance() }
                } else {
                    primary(pairing ? "正在打开相机…" : "扫码配对", id: "onboarding.mac.scan") { scanPairCode() }
                        .disabled(pairing)
                    secondary("跳过这一步", id: "onboarding.mac.skip") { advance() }
                }
            case .firstTask:
                primary("放进输入框", id: "onboarding.task.prefill") { finish(prefill: Self.samplePrompt) }
                secondary("直接开始", id: "onboarding.task.done") { finish(prefill: nil) }
            }
            if step != .model {
                Button("上一步") { go(to: OnboardingGate.Step(rawValue: step.rawValue - 1) ?? .model) }
                    .font(.footnote)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    .frame(minHeight: LeoTheme.TouchTarget.minimum)
            }
        }
    }

    private func primary(_ title: LocalizedStringKey, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum + 6)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .accessibilityIdentifier(id)
    }

    private func secondary(_ title: LocalizedStringKey, id: String = "", action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum)
        }
        .buttonStyle(.plain)
        .foregroundStyle(LeoTheme.ColorToken.accent)
        .accessibilityIdentifier(id)
    }

    private func advance() {
        guard let next = OnboardingGate.next(after: step) else { finish(prefill: nil); return }
        go(to: next)
    }

    private func go(to target: OnboardingGate.Step) {
        pairResult = nil
        if reduceMotion { step = target } else { withAnimation(.snappy) { step = target } }
    }

    private func scanPairCode() {
        pairing = true
        GatewayPairing.scan { message, _ in
            pairing = false
            pairResult = message
        }
    }

    private func finish(prefill: String?) {
        OnboardingGate.markCompleted()
        onFinish(prefill)
        if presentation == .pushed { dismiss() }
    }
}

/// [G2] 挂在首页根视图背后的零尺寸宿主:首启自动弹引导、接空状态的「新手引导」、
/// 接设置里走完引导后的示例任务。单独成视图,不往首页的修饰链里多塞泛型层。
struct OnboardingHost: View {
    /// 把示例任务放进首页输入框(并收起设置,如果开着)。
    let onPrefill: (String) -> Void

    @ObservedObject private var providerStore = ProviderConfigStore.shared
    @AppStorage("leo.releaseNotes.lastPresentedVersion") private var lastReleaseVersion = ""
    @State private var presented = false

    private var hasModel: Bool {
        providerStore.modelEntries.contains { ModelSwitcher.isAvailable($0, store: providerStore) }
    }

    private var releaseNotesPending: Bool {
        LeoReleaseCatalog.currentRelease != nil && lastReleaseVersion != LeoReleaseCatalog.currentVersion
    }

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .fullScreenCover(isPresented: $presented) {
                NavigationStack {
                    OnboardingFlowView(presentation: .cover) { prefill in
                        presented = false
                        if let prefill { onPrefill(prefill) }
                    }
                }
            }
            .onAppear { evaluate(after: 0.6) }
            // 「本次更新」关掉后再出,不跟它抢弹出。
            .onChange(of: lastReleaseVersion) { _, _ in evaluate(after: 0.8) }
            .onChange(of: hasModel) { _, configured in
                if OnboardingGate.shouldMarkCompleted(hasModel: configured) { OnboardingGate.markCompleted() }
            }
            .onReceive(NotificationCenter.default.publisher(for: .onboardingRequested)) { _ in
                presented = true
            }
            .onReceive(NotificationCenter.default.publisher(for: .onboardingPrefillRequested)) { note in
                if let prompt = note.userInfo?["prompt"] as? String { onPrefill(prompt) }
            }
    }

    private func evaluate(after delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            guard !presented, !releaseNotesPending else { return }
            if OnboardingGate.isForced() { presented = true; return }
            if OnboardingGate.shouldMarkCompleted(hasModel: hasModel) {
                OnboardingGate.markCompleted()
                return
            }
            presented = OnboardingGate.shouldPresent(hasModel: hasModel, completed: OnboardingGate.isCompleted(),
                                                     releaseNotesPending: releaseNotesPending)
        }
    }
}
