//
//  OnboardingStepPage.swift
//  MinisApp
//
//  [G2] 新手引导每一步的版式(进度点 + 图标 + 标题 + 说明 + 本步内容 + 底部按钮)。
//  只依赖 LeoTheme,编进逻辑测试,快照测试直接渲染它;逻辑在 OnboardingFlowView。
//

import SwiftUI

extension OnboardingGate.Step {
    var symbolName: String {
        switch self {
        case .model: return "cpu"
        case .mac: return "macbook.and.iphone"
        case .firstTask: return "paperplane"
        }
    }

    var title: LocalizedStringKey {
        switch self {
        case .model: return "连接模型"
        case .mac: return "配对 Mac"
        case .firstTask: return "派第一个任务"
        }
    }

    var message: LocalizedStringKey {
        switch self {
        case .model: return "LeoBot 靠大模型思考和干活。添加一个模型服务商（填 API Key 或登录账号）就能开始。"
        case .mac: return "在 Mac 上的 LeoBot 打开配对二维码，用手机扫一下，就能把任务派给 Mac 去做。没有 Mac 可以跳过。"
        case .firstTask: return "试试让 LeoBot 帮你做件事。下面这句会放进首页输入框，改一改再发送。"
        }
    }
}

struct OnboardingStepPage<Detail: View, Actions: View>: View {
    let step: OnboardingGate.Step
    var transition: AnyTransition = .opacity
    /// 快照测试里关掉:ImageRenderer 画不出 ScrollView 里的内容。
    var scrollable = true
    @ViewBuilder var detail: Detail
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 0) {
            OnboardingProgressDots(step: step)
                .padding(.top, LeoTheme.Spacing.md)
            if scrollable {
                ScrollView { placedContent }
                    .scrollBounceBehavior(.basedOnSize)
            } else {
                placedContent
                Spacer(minLength: 0)
            }
            VStack(spacing: LeoTheme.Spacing.xs) { actions }
                .frame(maxWidth: 520)
                .padding(.horizontal, LeoTheme.Spacing.xl)
                .padding(.bottom, LeoTheme.Spacing.lg)
        }
        .background(LeoTheme.ColorToken.groupedBackground.ignoresSafeArea())
    }

    private var placedContent: some View {
        content
            .id(step)
            .transition(transition)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, LeoTheme.Spacing.xl)
            .padding(.top, LeoTheme.Spacing.xl)
    }

    private var content: some View {
        VStack(spacing: LeoTheme.Spacing.lg) {
            Image(systemName: step.symbolName)
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(LeoTheme.ColorToken.accent)
                .frame(width: 72, height: 72)
                .background(LeoTheme.ColorToken.accentSoft, in: Circle())
                .accessibilityHidden(true)
            VStack(spacing: LeoTheme.Spacing.sm) {
                Text(step.title)
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
                    .accessibilityAddTraits(.isHeader)
                Text(step.message)
                    .font(.body)
                    .foregroundStyle(LeoTheme.ColorToken.secondaryText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            detail
        }
    }
}

struct OnboardingProgressDots: View {
    let step: OnboardingGate.Step

    var body: some View {
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
}

/// 引导里的按钮与状态行,版式统一放这里。
enum OnboardingUI {
    static func primary(_ title: LocalizedStringKey, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum + 6)
        }
        .buttonStyle(.borderedProminent)
        .buttonBorderShape(.capsule)
        .accessibilityIdentifier(id)
    }

    static func secondary(_ title: LocalizedStringKey, id: String = "", action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum)
        }
        .buttonStyle(.plain)
        .foregroundStyle(LeoTheme.ColorToken.accent)
        .accessibilityIdentifier(id)
    }

    static func back(action: @escaping () -> Void) -> some View {
        Button("上一步", action: action)
            .font(.footnote)
            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            .frame(minHeight: LeoTheme.TouchTarget.minimum)
    }

    static func status(_ text: Text) -> some View {
        Label { text } icon: {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(LeoTheme.ColorToken.success)
        }
        .font(.subheadline.weight(.semibold))
        .padding(.horizontal, LeoTheme.Spacing.md)
        .padding(.vertical, LeoTheme.Spacing.xs)
        .background(LeoTheme.ColorToken.surface, in: Capsule())
    }

    static func samplePromptCard(_ prompt: String) -> some View {
        Text(prompt)
            .font(.callout)
            .foregroundStyle(LeoTheme.ColorToken.primaryText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(LeoTheme.Spacing.md)
            .background(LeoTheme.ColorToken.surface,
                        in: RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous))
    }

    static func note(_ text: Text) -> some View {
        text
            .font(.footnote)
            .foregroundStyle(LeoTheme.ColorToken.secondaryText)
            .multilineTextAlignment(.center)
    }
}
