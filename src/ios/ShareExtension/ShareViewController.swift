import SwiftUI
import UIKit

/// The Share Extension's principal view controller.
///
/// [T-collections] 双模式:「发到对话」(存 pendingShare + 跳回主 app,
/// 原有管道)或「收藏」(写入收藏库,不打断当前 app)。默认动作可在主 app
/// 设置里配置:每次询问 / 总是发对话 / 总是收藏(三星式自动收藏)。
class ShareViewController: UIViewController {

    private var vm: ShareViewModel?
    /// 弹选择卡时置 true,阻止 viewDidAppear 提前 completeRequest。
    private var awaitingChoice = false
    private var processingDone = false
    private var hasAppeared = false
    private var isFinished = false
    private var pendingAutoAction: String?
    private var pendingPresentChoice = false
    private var macSendTask: Task<Void, Never>?
    private var sheetState = ShareSheetState()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear

        Task { @MainActor in
            let vm = ShareViewModel()
            self.vm = vm
            let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
            await vm.processExtensionItems(items)

            let action = SharedContainerStore.sharedDefaults?
                .string(forKey: CollectionStore.defaultActionKey) ?? "ask"
            // [V-rec] 有音频时总是问一句:转成录音纪要,还是照常发到对话 / 收藏。
            if vm.hasAudio {
                self.awaitingChoice = true
                self.presentChoice()
                return
            }
            switch action {
            case "chat", "collect":
                self.runAutoAction(action)
            default:
                self.awaitingChoice = true
                self.presentChoice()
            }
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        hasAppeared = true
        if let auto = pendingAutoAction {
            pendingAutoAction = nil
            runAutoAction(auto)
            return
        }
        if pendingPresentChoice {
            pendingPresentChoice = false
            presentChoice()
            return
        }
        if processingDone && !awaitingChoice {
            finish()
        }
    }

    private func runAutoAction(_ action: String) {
        guard hasAppeared, view.window != nil else {
            pendingAutoAction = action
            return
        }
        if action == "chat" {
            sendToChat(note: "")
        } else {
            collect(note: "")
        }
    }

    // MARK: - Native SwiftUI Half-Sheet Card

    private func presentChoice() {
        guard hasAppeared, view.window != nil else {
            pendingPresentChoice = true
            return
        }
        guard let vm else { return finish() }
        let macTarget: ShareMacTarget? = {
            guard let target = ShareMacTarget.load(),
                  target.isFresh(),
                  ShareMacTargetSecrets.load() != nil,
                  !vm.macShareText.isEmpty else { return nil }
            return target
        }()

        let card = ShareSheetCardView(
            summary: vm.previewSummary,
            hasAudio: vm.hasAudio,
            macTargetTitle: macTarget?.title,
            state: sheetState,
            onRecordings: { [weak self] note in self?.sendToRecordings(note: note) },
            onChat: { [weak self] note in self?.sendToChat(note: note) },
            onCollect: { [weak self] note in self?.collect(note: note) },
            onMac: macTarget.map { target in { [weak self] note in self?.sendToMac(target, note: note) } },
            onDismiss: { [weak self] in self?.finish() }
        )
        let host = UIHostingController(rootView: card)
        host.view.backgroundColor = .systemBackground
        host.modalPresentationStyle = .pageSheet
        if let sheet = host.sheetPresentationController {
            sheet.detents = [.medium(), .large()]
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 24
        }
        host.isModalInPresentation = false
        host.presentationController?.delegate = self
        present(host, animated: true)
    }

    private func sendToChat(note: String) {
        guard let vm else { return finish() }
        vm.prependNote(note)
        _ = vm.save()
        sheetState.successFeedbackTick += 1
        redirectToHostApp { [weak self] in
            self?.finish()
        }
    }

    private func sendToRecordings(note: String) {
        guard let vm, vm.saveRecordingImports() else { return finish() }
        vm.prependNote(note)
        // 同一次分享里的非音频内容照常进对话信箱。
        _ = vm.save()
        sheetState.successFeedbackTick += 1
        redirect(to: "leophoneagent://recordings/import") { [weak self] in
            self?.finish()
        }
    }

    private func collect(note: String) {
        guard let vm else { return finish() }
        vm.prependNote(note)
        // 不落 pendingShare(那是对话管道的信箱),直接从物料建收藏。
        let count = CollectionStore.ingest(vm.builtShare())
        NSLog("[ShareExt] collected %d item(s)", count)
        sheetState.successFeedbackTick += 1
        guard awaitingChoice else {
            finish()
            return
        }
        sheetState.statusTitle = "已收藏"
        sheetState.statusDetail = count > 1 ? "已保存 \(count) 项到本地收藏" : "已保存到本地收藏"
        sheetState.isSuccess = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(550))
            self?.finish()
        }
    }

    private func sendToMac(_ target: ShareMacTarget, note: String) {
        guard let vm, let secrets = ShareMacTargetSecrets.load() else { return finish() }
        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let payload = trimmedNote.isEmpty ? vm.macShareText : "\(trimmedNote)\n\n\(vm.macShareText)"
        let requests = target.attempts(text: payload, secrets: secrets)
        sheetState.isSendingToMac = true
        macSendTask?.cancel()
        macSendTask = Task { @MainActor [weak self] in
            let outcome = await Self.deliver(requests)
            guard !Task.isCancelled, let self, !self.isFinished else { return }
            self.sheetState.isSendingToMac = false
            self.sheetState.statusTitle = outcome.title
            self.sheetState.statusDetail = outcome.detail
            let ok = outcome.title.contains("已接收") || outcome.title.contains("已确认")
            self.sheetState.isSuccess = ok
            if ok {
                self.sheetState.successFeedbackTick += 1
            } else {
                self.sheetState.warningFeedbackTick += 1
            }
        }
    }

    /// Direct first, then relay (queued when the Mac is offline). Same request id on both,
    /// so a direct attempt that timed out after reaching the Mac is not delivered twice.
    private static func deliver(_ requests: [ShareMacTarget.Attempt]) async -> (title: String, detail: String?) {
        let started = Date()
        var lastError = "没有可用的连接"
        for attempt in requests {
            var req = attempt.request
            let remaining = ShareMacTarget.totalBudget - Date().timeIntervalSince(started)
            guard remaining > 1 else { break }
            req.timeoutInterval = min(req.timeoutInterval, max(1, remaining - 4))
            do {
                let (data, response) = try await URLSession.shared.data(for: req)
                var status = (response as? HTTPURLResponse)?.statusCode ?? 0
                var body = data
                if let keys = attempt.keys {
                    switch RelayE2E.reply(status: status, data: data, keys: keys, queued: true) {
                    case let .opened(innerStatus, innerBody): status = innerStatus; body = innerBody
                    case .fallback:
                        // Only an explicit unsupported-envelope response permits plaintext fallback.
                        if case .fallback = RelayE2E.classify(status: status, data: data, queued: true) { continue }
                        return await resolveShare(attempt, started: started)
                    case .passthrough: break
                    }
                }
                if (200..<300).contains(status) {
                    let result = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
                    return status == 202 || result?["queued"] as? Bool == true
                        ? ("已接收，待主机确认", "可在原 Mac 任务中查看进度。")
                        : ("Mac 已确认接收", nil)
                }
                if status == 401 || status == 403 { return ("Mac 拒绝了这次发送", "打开 LeoBot 重新连接这台 Mac 后再试。") }
                if ![502, 503, 504].contains(status) { return ("没发出去", "Mac 返回 \(status)。") }
                return await resolveShare(attempt, started: started)
            } catch {
                lastError = error.localizedDescription
                if ![URLError.notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains((error as? URLError)?.code ?? .unknown) {
                    return await resolveShare(attempt, started: started)
                }
                // 加密那条连中继都没连上:不再拿明文去试(可能只是慢,明文会让中继看到内容)。
                if ShareMacTarget.isSealed(req) { break }
            }
        }
        return ("没发出去", lastError)
    }

    /// A timeout may follow a successful write. Ask about that exact operation on the
    /// same authenticated route and do not submit a second prompt on an ambiguous result.
    private static func resolveShare(_ attempt: ShareMacTarget.Attempt, started: Date) async -> (title: String, detail: String?) {
        let unknown = ("发送状态待确认", "请打开原 Mac 任务查看本次分享。")
        var request = attempt.receipt
        let remaining = ShareMacTarget.totalBudget - Date().timeIntervalSince(started)
        guard remaining > 0 else { return unknown }
        request.timeoutInterval = min(remaining, 4)
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let receipt = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let requestId = attempt.request.value(forHTTPHeaderField: "X-Leo-Request-Id"),
              receipt["requestId"] as? String == requestId else { return unknown }
        if receipt["state"] as? String == "uncertain" { return ("已接收，待主机确认", nil) }
        guard receipt["state"] as? String == "completed", let saved = receipt["response"] as? [String: Any],
              let status = saved["status"] as? Int else { return unknown }
        if status == 202 { return ("已接收，待主机确认", nil) }
        return (200..<300).contains(status) ? ("Mac 已确认接收", nil) : ("Mac 未接受分享", "Mac 返回 \(status)。")
    }

    private func finish() {
        guard !isFinished else { return }
        isFinished = true
        processingDone = true
        awaitingChoice = false
        macSendTask?.cancel()
        macSendTask = nil
        extensionContext?.completeRequest(returningItems: [])
    }

    // MARK: - Redirect to main app

    private func redirectToHostApp(completion: @escaping () -> Void) {
        redirect(to: "leophoneagent://share", completion: completion)
    }

    private func redirect(to link: String, completion: @escaping () -> Void) {
        guard let url = URL(string: link) else {
            completion()
            return
        }
        var responder: UIResponder? = self
        while responder != nil {
            if let application = responder as? UIApplication {
                application.open(url, options: [:]) { _ in
                    Task { @MainActor in completion() }
                }
                return
            }
            responder = responder?.next
        }
        completion()
    }
}

extension ShareViewController: UIAdaptivePresentationControllerDelegate {
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        finish()
    }
}

// MARK: - SwiftUI Share Card

@MainActor
private final class ShareSheetState: ObservableObject {
    @Published var isSendingToMac = false
    @Published var statusTitle: String?
    @Published var statusDetail: String?
    @Published var isSuccess = true
    @Published var successFeedbackTick = 0
    @Published var warningFeedbackTick = 0
}

private struct ShareSheetCardView: View {
    let summary: ShareViewModel.PreviewSummary
    let hasAudio: Bool
    let macTargetTitle: String?
    @ObservedObject var state: ShareSheetState
    let onRecordings: (String) -> Void
    let onChat: (String) -> Void
    let onCollect: (String) -> Void
    let onMac: ((String) -> Void)?
    let onDismiss: () -> Void

    @State private var note = ""
    @State private var selectionFeedbackTick = 0

    private static let brandBlue = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 107/255, green: 159/255, blue: 1.0, alpha: 1)
            : UIColor(red: 43/255, green: 92/255, blue: 230/255, alpha: 1)
    })

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    previewCard

                    if let statusTitle = state.statusTitle {
                        statusCard(title: statusTitle, detail: state.statusDetail, ok: state.isSuccess)
                    } else {
                        TextField("补充一句说明或指令（可选）", text: $note)
                            .textFieldStyle(.plain)
                            .font(.subheadline)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .disabled(state.isSendingToMac)

                        VStack(spacing: 8) {
                            if hasAudio {
                                actionRow(icon: "waveform", title: "转写成录音纪要", subtitle: "本机保存与转写，不上传原音频", prominent: true) {
                                    selectionFeedbackTick += 1
                                    onRecordings(note)
                                }
                            }
                            actionRow(icon: "bubble.left.and.text.bubble.right.fill",
                                      title: "发到对话",
                                      subtitle: "带着内容打开 LeoBot 继续处理",
                                      prominent: !hasAudio) {
                                selectionFeedbackTick += 1
                                onChat(note)
                            }
                            actionRow(icon: "bookmark.fill",
                                      title: "收藏",
                                      subtitle: "存到本地收藏，不打断当前页面") {
                                selectionFeedbackTick += 1
                                onCollect(note)
                            }
                            if let macTitle = macTargetTitle, let onMac {
                                actionRow(icon: "desktopcomputer",
                                          title: "发给 Mac：\(macTitle)",
                                          subtitle: state.isSendingToMac ? "正在发送…" : "直接续发到当前 Mac 任务",
                                          loading: state.isSendingToMac) {
                                    selectionFeedbackTick += 1
                                    onMac(note)
                                }
                            }
                        }
                        .disabled(state.isSendingToMac)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
            }
            .navigationTitle("分享到 LeoBot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(state.statusTitle == nil ? "取消" : "完成") { onDismiss() }
                }
            }
        }
        .tint(Self.brandBlue)
        .sensoryFeedback(.selection, trigger: selectionFeedbackTick)
        .sensoryFeedback(.success, trigger: state.successFeedbackTick)
        .sensoryFeedback(.warning, trigger: state.warningFeedbackTick)
    }

    private var previewCard: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: summary.icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Self.brandBlue)
                .frame(width: 34, height: 34)
                .background(Self.brandBlue.opacity(0.12), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(summary.headline)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                if let detail = summary.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func statusCard(title: String, detail: String?, ok: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .font(.title3)
                    .foregroundStyle(ok ? Self.brandBlue : .orange)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    if let detail, !detail.isEmpty {
                        Text(detail).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            HStack(spacing: 10) {
                if !ok {
                    Button {
                        state.statusTitle = nil
                        state.statusDetail = nil
                    } label: {
                        Text("返回重选")
                            .font(.subheadline.weight(.medium))
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.bordered)
                }
                Button {
                    onDismiss()
                } label: {
                    Text("好")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func actionRow(icon: String,
                           title: String,
                           subtitle: String,
                           prominent: Bool = false,
                           loading: Bool = false,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                if loading {
                    ProgressView()
                        .frame(width: 24, height: 24)
                } else {
                    Image(systemName: icon)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(prominent ? .white : Self.brandBlue)
                        .frame(width: 24, height: 24)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(prominent ? .white : .primary)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(prominent ? .white.opacity(0.82) : .secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(prominent ? Color.white.opacity(0.75) : Color(.tertiaryLabel))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
            .background(
                prominent ? AnyShapeStyle(Self.brandBlue) : AnyShapeStyle(Color(.secondarySystemGroupedBackground)),
                in: RoundedRectangle(cornerRadius: 14, style: .continuous)
            )
            .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
