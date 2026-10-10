//
//  AskUserCardView.swift
//  MinisApp
//
//  [T-ask-user] The question card that stands in for an ask_user tool capsule.
//  Waiting → buttons / a short text field; answered → a compact record of the
//  answer; stopped / dismissed → a quiet line. Everything it shows comes from
//  the saved call + result (so it survives a restart) plus the live wait in
//  AskUserCenter or the chat's dormant question.
//

import SwiftUI

struct AskUserCardView: View {
    @ObservedObject var block: AssistantBlock
    let messageId: UUID
    @EnvironmentObject private var vm: AIChatViewModel
    @ObservedObject private var center = AskUserCenter.shared

    var body: some View {
        let request = vm.askUserRequest(for: block)
        if let decoded = AskUserResult.decode(block.content)
            ?? block.toolUseId.flatMap({ center.outcomes[$0] }).flatMap({ AskUserResult.decode(AskUserResult.content(for: $0).text) }) {
            resolvedView(decoded, request: request)
        } else if let id = block.toolUseId, let request,
                  center.isWaiting(id) || vm.dormantAskUserToolUseId == id {
            interactive(id: id, request: request)
        } else if isPreparing {
            quietLine(icon: "questionmark.bubble", text: String(localized: "正在准备问题…"), progress: true)
        } else {
            expiredView(request)
        }
    }

    private var isPreparing: Bool {
        switch block.toolStatus {
        case .running, .streaming: return vm.isProcessing
        default: return false
        }
    }

    // MARK: Waiting

    @ViewBuilder
    private func interactive(id: String, request: AskUserRequest) -> some View {
        let draft = center.drafts[id] ?? AskUserDraft()
        let step = min(draft.step, request.questions.count - 1)
        let question = request.questions[step]
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.bubble.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(ChatColors.accent)
                    .accessibilityHidden(true)
                Text("需要你决定")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ChatColors.primaryText)
                Spacer(minLength: 8)
                if request.isMultiStep {
                    Text("第 \(step + 1)/\(request.questions.count) 题")
                        .font(.caption.weight(.medium))
                        .monospacedDigit()
                        .foregroundStyle(ChatColors.secondaryText)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)

            Text(question.prompt)
                .font(.body.weight(.medium))
                .foregroundStyle(ChatColors.primaryText)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

            switch question.kind {
            case .choice:
                VStack(spacing: 8) {
                    ForEach(Array(question.options.enumerated()), id: \.offset) { _, option in
                        optionButton(label: option, value: option, isDefault: question.defaultAnswer == option,
                                     selected: previousAnswer(draft, step) == option, id: id, request: request)
                    }
                    if question.allowsOther {
                        if draft.otherOpen {
                            textEntry(id: id, request: request, isOther: true, placeholder: String(localized: "写下你的答案"))
                        } else {
                            Button {
                                updateDraft(id) { $0.otherOpen = true }
                            } label: {
                                Label("其他（自己填）", systemImage: "square.and.pencil")
                                    .font(.subheadline)
                                    .foregroundStyle(ChatColors.accent)
                                    .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum, alignment: .leading)
                                    .padding(.horizontal, 14)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint(Text("打开输入框，写自己的答案"))
                        }
                    }
                }
            case .yesNo:
                HStack(spacing: 8) {
                    ForEach(AskUserTool.yesNoTokens, id: \.self) { token in
                        optionButton(label: Self.yesNoLabel(token), value: token,
                                     isDefault: question.defaultAnswer == token,
                                     selected: previousAnswer(draft, step) == token, id: id, request: request)
                    }
                }
            case .text:
                VStack(alignment: .leading, spacing: 8) {
                    textEntry(id: id, request: request, isOther: false,
                              placeholder: String(localized: "你的回答"))
                    if let suggestion = question.defaultAnswer, draft.text.isEmpty {
                        Button {
                            updateDraft(id) { $0.text = suggestion }
                        } label: {
                            Text("用推荐：\(suggestion)")
                                .font(.footnote)
                                .lineLimit(1)
                                .foregroundStyle(ChatColors.accent)
                                .frame(minHeight: LeoTheme.TouchTarget.minimum)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            HStack(spacing: 8) {
                if step > 0 {
                    Button {
                        updateDraft(id) { d in
                            d.step = max(0, d.step - 1)
                            d.otherOpen = false
                            d.text = ""
                        }
                    } label: {
                        Label("上一题", systemImage: "chevron.left")
                            .font(.footnote.weight(.medium))
                            .frame(minWidth: LeoTheme.TouchTarget.minimum, minHeight: LeoTheme.TouchTarget.minimum)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(ChatColors.accent)
                }
                Spacer(minLength: 0)
                Text("也可以直接在输入框回复")
                    .font(.caption)
                    .foregroundStyle(ChatColors.tertiaryText)
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous)
                .fill(ChatColors.accent.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: LeoTheme.Radius.surface, style: .continuous)
                .stroke(ChatColors.accent.opacity(0.28), lineWidth: 1)
        )
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("需要你决定的问题"))
    }

    private func optionButton(label: String, value: String, isDefault: Bool, selected: Bool,
                              id: String, request: AskUserRequest) -> some View {
        Button {
            choose(AskUserAnswerInput(value: value), id: id, request: request)
        } label: {
            HStack(spacing: 8) {
                Text(label)
                    .font(.body)
                    .foregroundStyle(ChatColors.primaryText)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 6)
                if isDefault {
                    Text("推荐")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(ChatColors.accent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(ChatColors.accent.opacity(0.14)))
                }
                if selected {
                    Image(systemName: "checkmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(ChatColors.accent)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: LeoTheme.TouchTarget.minimum, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous)
                    .fill(LeoTheme.ColorToken.elevatedSurface)
            )
            .overlay(
                RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous)
                    .stroke(selected ? ChatColors.accent.opacity(0.6) : ChatColors.toolBorder, lineWidth: selected ? 1.5 : 0.5)
            )
            .contentShape(RoundedRectangle(cornerRadius: LeoTheme.Radius.field))
        }
        .buttonStyle(LeoSquishButtonStyle())
        .accessibilityLabel(isDefault ? Text("\(label)，推荐") : Text(label))
        .accessibilityHint(Text("选择这个答案"))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func textEntry(id: String, request: AskUserRequest, isOther: Bool, placeholder: String) -> some View {
        let text = center.drafts[id]?.text ?? ""
        let canSend = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return HStack(spacing: 8) {
            TextField(placeholder, text: textBinding(id))
                .font(.body)
                .submitLabel(.send)
                .onSubmit {
                    guard canSend else { return }
                    choose(AskUserAnswerInput(value: text, isOther: isOther), id: id, request: request)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: LeoTheme.TouchTarget.minimum)
                .background(
                    RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous)
                        .fill(LeoTheme.ColorToken.elevatedSurface)
                )
                .accessibilityLabel(Text("你的回答"))
            Button {
                choose(AskUserAnswerInput(value: text, isOther: isOther), id: id, request: request)
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 28))
                    .foregroundStyle(canSend ? ChatColors.sendButton : ChatColors.sendButtonDisabled)
                    .frame(width: LeoTheme.TouchTarget.minimum, height: LeoTheme.TouchTarget.minimum)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel(Text("发送回答"))
        }
    }

    // MARK: Actions

    private func choose(_ input: AskUserAnswerInput, id: String, request: AskUserRequest) {
        var draft = center.drafts[id] ?? AskUserDraft()
        let step = min(draft.step, request.questions.count - 1)
        draft.answers = Array(draft.answers.prefix(step)) + [input]
        if step + 1 < request.questions.count {
            draft.step = step + 1
            draft.otherOpen = false
            draft.text = ""
            center.drafts[id] = draft
            LeoHaptics.selection()
            vm.signalAskUserCard(id)
            return
        }
        if vm.answerAskUser(toolUseId: id, inputs: draft.answers, source: .card) {
            LeoHaptics.notification(.success)
        } else {
            LeoHaptics.notification(.error)
        }
    }

    private func updateDraft(_ id: String, _ change: (inout AskUserDraft) -> Void) {
        var draft = center.drafts[id] ?? AskUserDraft()
        change(&draft)
        center.drafts[id] = draft
        vm.signalAskUserCard(id)
    }

    private func textBinding(_ id: String) -> Binding<String> {
        Binding(
            get: { center.drafts[id]?.text ?? "" },
            set: { newValue in
                var draft = center.drafts[id] ?? AskUserDraft()
                draft.text = String(newValue.prefix(AskUserTool.maxAnswerLength))
                center.drafts[id] = draft
            })
    }

    private func previousAnswer(_ draft: AskUserDraft, _ step: Int) -> String? {
        step < draft.answers.count ? draft.answers[step].value : nil
    }

    static func yesNoLabel(_ token: String) -> String {
        token == "yes" ? String(localized: "是") : String(localized: "否")
    }

    // MARK: Resolved / expired

    private func resolvedView(_ decoded: AskUserResult.Decoded, request: AskUserRequest?) -> some View {
        let answered = decoded.status == .answered
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: answered ? "checkmark.bubble.fill" : "xmark.bubble")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(answered ? ChatColors.accent : ChatColors.secondaryText)
                    .accessibilityHidden(true)
                Text(answered ? String(localized: "已回答") : String(localized: "问题已关闭"))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(ChatColors.secondaryText)
                if let note = sourceNote(decoded) {
                    Text(verbatim: "· \(note)")
                        .font(.footnote)
                        .foregroundStyle(ChatColors.tertiaryText)
                }
            }
            if answered {
                ForEach(Array(decoded.answers.enumerated()), id: \.offset) { index, answer in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(answer.question)
                            .font(.footnote)
                            .foregroundStyle(ChatColors.secondaryText)
                            .lineLimit(3)
                        Text(displayAnswer(answer, index: index, request: request))
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(ChatColors.primaryText)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                }
            } else {
                if let prompt = request?.questions.first?.prompt {
                    Text(prompt)
                        .font(.footnote)
                        .foregroundStyle(ChatColors.secondaryText)
                        .lineLimit(2)
                }
                Text(decoded.reason == .superseded
                     ? String(localized: "你发了新消息，这个问题就不再等了。")
                     : String(localized: "任务停止了，问题没有回答。"))
                    .font(.footnote)
                    .foregroundStyle(ChatColors.tertiaryText)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: LeoTheme.Radius.field, style: .continuous)
                .fill(ChatColors.toolBg)
        )
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private func expiredView(_ request: AskUserRequest?) -> some View {
        let failed: Bool = { if case .failed = block.toolStatus { return true }; return false }()
        return VStack(alignment: .leading, spacing: 4) {
            quietLine(icon: "questionmark.bubble",
                      text: failed && request == nil
                        ? String(localized: "问题格式不对，没有显示")
                        : String(localized: "这个问题已失效"),
                      progress: false)
            if let prompt = request?.questions.first?.prompt {
                Text(prompt)
                    .font(.footnote)
                    .foregroundStyle(ChatColors.tertiaryText)
                    .lineLimit(2)
                    .padding(.leading, 4)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func quietLine(icon: String, text: String, progress: Bool) -> some View {
        HStack(spacing: 6) {
            if progress {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: icon)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(ChatColors.secondaryText)
            }
            Text(text)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(ChatColors.secondaryText)
                .lineLimit(1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(ChatColors.toolBg, in: Capsule())
    }

    private func sourceNote(_ decoded: AskUserResult.Decoded) -> String? {
        switch decoded.source {
        case .notification: return String(localized: "在通知里回答")
        case .typedMessage: return String(localized: "在输入框回复")
        default: return nil
        }
    }

    private func displayAnswer(_ answer: AskUserAnswer, index: Int, request: AskUserRequest?) -> String {
        if let request, index < request.questions.count, request.questions[index].kind == .yesNo,
           AskUserTool.yesNoTokens.contains(answer.answer) {
            return Self.yesNoLabel(answer.answer)
        }
        return answer.answer
    }
}
