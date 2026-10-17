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
            case "chat":
                self.sendToChat()
            case "collect":
                self.collect()
            default:
                self.awaitingChoice = true
                self.presentChoice()
            }
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        if processingDone && !awaitingChoice {
            extensionContext?.completeRequest(returningItems: [])
        }
    }

    // MARK: - 两种去向

    private func presentChoice() {
        let alert = UIAlertController(title: "分享到 LeoBot",
                                      message: nil, preferredStyle: .alert)
        if vm?.hasAudio == true {
            alert.message = "音频只保存在这台设备上;转写默认在本机完成。"
            alert.addAction(UIAlertAction(title: "🎙 转写成录音纪要", style: .default) { [weak self] _ in
                self?.sendToRecordings()
            })
        }
        alert.addAction(UIAlertAction(title: "💬 发到对话", style: .default) { [weak self] _ in
            self?.sendToChat()
        })
        alert.addAction(UIAlertAction(title: "⭐️ 收藏", style: .default) { [weak self] _ in
            self?.collect()
        })
        // [WP-44] Straight into the Mac task last opened on this phone (text / links only).
        if let target = ShareMacTarget.load(), target.isFresh(), ShareMacTargetSecrets.load() != nil,
           !(vm?.macShareText.isEmpty ?? true) {
            alert.addAction(UIAlertAction(title: "🖥 发给 Mac:\(target.title)", style: .default) { [weak self] _ in
                self?.sendToMac(target)
            })
        }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in
            self?.finish()
        })
        present(alert, animated: true)
    }

    private func sendToChat() {
        guard let vm else { return finish() }
        _ = vm.save()
        redirectToHostApp()
        finish()
    }

    private func sendToRecordings() {
        guard let vm, vm.saveRecordingImports() else { return finish() }
        // 同一次分享里的非音频内容照常进对话信箱。
        _ = vm.save()
        redirect(to: "leophoneagent://recordings/import")
        finish()
    }

    private func collect() {
        guard let vm else { return finish() }
        // 不落 pendingShare(那是对话管道的信箱),直接从物料建收藏。
        let count = CollectionStore.ingest(vm.builtShare())
        NSLog("[ShareExt] collected %d item(s)", count)
        finish()
    }

    private func sendToMac(_ target: ShareMacTarget) {
        guard let vm, let secrets = ShareMacTargetSecrets.load() else { return finish() }
        let requests = target.requests(text: vm.macShareText, secrets: secrets)
        Task { @MainActor [weak self] in
            let outcome = await Self.deliver(requests)
            guard let self else { return }
            let alert = UIAlertController(title: outcome.title, message: outcome.detail, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "好", style: .default) { [weak self] _ in self?.finish() })
            self.present(alert, animated: true)
        }
    }

    /// Direct first, then relay (queued when the Mac is offline). Same request id on both,
    /// so a direct attempt that timed out after reaching the Mac is not delivered twice.
    private static func deliver(_ requests: [URLRequest]) async -> (title: String, detail: String?) {
        let started = Date()
        var lastError = "没有可用的连接"
        for request in requests {
            var req = request
            let remaining = ShareMacTarget.totalBudget - Date().timeIntervalSince(started)
            guard remaining > 1 else { break }
            req.timeoutInterval = min(req.timeoutInterval, remaining)
            do {
                let (data, response) = try await URLSession.shared.data(for: req)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200..<300).contains(status) {
                    let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                    return (obj?["queued"] as? Bool) == true
                        ? ("已排队", "Mac 现在不在线,上线后按顺序送达。")
                        : ("已发给 Mac", nil)
                }
                if status == 401 || status == 403 { return ("Mac 拒绝了这次发送", "打开 LeoBot 重新连接这台 Mac 后再试。") }
                if ![502, 503, 504].contains(status) { return ("没发出去", "Mac 返回 \(status)。") }
                lastError = "Mac 返回 \(status)"
            } catch {
                lastError = error.localizedDescription
            }
        }
        return ("没发出去", lastError)
    }

    private func finish() {
        processingDone = true
        awaitingChoice = false
        extensionContext?.completeRequest(returningItems: [])
    }

    // MARK: - Redirect to main app

    private func redirectToHostApp() {
        redirect(to: "leophoneagent://share")
    }

    private func redirect(to link: String) {
        guard let url = URL(string: link) else { return }
        let selectorOpenURL = sel_registerName("openURL:")
        var responder: UIResponder? = self
        while responder != nil {
            if let application = responder as? UIApplication {
                application.open(url, options: [:], completionHandler: nil)
                break
            }
            responder = responder?.next
        }
    }
}
