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
        OnboardingStepPage(step: step, transition: stepTransition) {
            stepDetail
        } actions: {
            stepActions
        }
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

    private var stepTransition: AnyTransition {
        reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity),
                                              removal: .move(edge: .leading).combined(with: .opacity))
    }

    @ViewBuilder
    private var stepDetail: some View {
        switch step {
        case .model:
            if hasModel { OnboardingUI.status(Text("模型已连接")) }
        case .mac:
            if hasMac { OnboardingUI.status(Text("已配对 Mac")) }
            if let pairResult { OnboardingUI.note(Text(verbatim: pairResult)) }
        case .firstTask:
            OnboardingUI.samplePromptCard(Self.samplePrompt)
            if !hasModel { OnboardingUI.note(Text("还没连接模型：发送时会先请你连接。")) }
        }
    }

    @ViewBuilder
    private var stepActions: some View {
        switch step {
        case .model:
            if hasModel {
                OnboardingUI.primary("下一步", id: "onboarding.next") { advance() }
                if providerStore.defaultPrimaryGroupId == nil {
                    OnboardingUI.secondary("选择默认模型", id: "onboarding.model.defaults") { showDefaultModels = true }
                }
            } else {
                OnboardingUI.primary("添加模型服务商", id: "onboarding.model.add") {
                    if providerStore.instances.isEmpty { showAddProvider = true } else { showModelLibrary = true }
                }
                OnboardingUI.secondary("稍后再说", id: "onboarding.model.later") { advance() }
            }
        case .mac:
            if hasMac {
                OnboardingUI.primary("下一步", id: "onboarding.next") { advance() }
            } else {
                OnboardingUI.primary(pairing ? "正在打开相机…" : "扫码配对", id: "onboarding.mac.scan") { scanPairCode() }
                    .disabled(pairing)
                OnboardingUI.secondary("跳过这一步", id: "onboarding.mac.skip") { advance() }
            }
        case .firstTask:
            OnboardingUI.primary("放进输入框", id: "onboarding.task.prefill") { finish(prefill: Self.samplePrompt) }
            OnboardingUI.secondary("直接开始", id: "onboarding.task.done") { finish(prefill: nil) }
        }
        if step != .model {
            OnboardingUI.back { go(to: OnboardingGate.Step(rawValue: step.rawValue - 1) ?? .model) }
        }
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
