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
        let alert = UIAlertController(title: "分享到 LeoPhoneAgent",
                                      message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "💬 发到对话", style: .default) { [weak self] _ in
            self?.sendToChat()
        })
        alert.addAction(UIAlertAction(title: "⭐️ 收藏", style: .default) { [weak self] _ in
            self?.collect()
        })
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

    private func collect() {
        guard let vm else { return finish() }
        // 不落 pendingShare(那是对话管道的信箱),直接从物料建收藏。
        let count = CollectionStore.ingest(vm.builtShare())
        NSLog("[ShareExt] collected %d item(s)", count)
        finish()
    }

    private func finish() {
        processingDone = true
        awaitingChoice = false
        extensionContext?.completeRequest(returningItems: [])
    }

    // MARK: - Redirect to main app

    private func redirectToHostApp() {
        guard let url = URL(string: "leophoneagent://share") else { return }
        let selectorOpenURL = sel_registerName("openURL:")
        var responder: UIResponder? = self
        while responder != nil {
            if let application = responder as? UIApplication {
                if #available(iOS 18.0, *) {
                    application.open(url, options: [:], completionHandler: nil)
                } else {
                    application.perform(selectorOpenURL, with: url)
                }
                break
            }
            responder = responder?.next
        }
    }
}
