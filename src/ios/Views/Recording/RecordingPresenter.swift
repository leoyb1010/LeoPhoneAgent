import SwiftUI
import UIKit

/// [V-rec] 打开录音页:从当前最上层的控制器弹出(和备份恢复同样的做法),不往 WindowGroup 根上再挂 `.sheet` ——
/// 那条修饰链已经贴着启动时的类型解码栈上限。首页、对话「+」菜单、深链、灵动岛都走这里。
@MainActor
enum RecordingPresenter {
    private static weak var presented: UIViewController?

    enum Start {
        case list
        /// 正在录音时直接到录音页;没在录音就是列表。深链永远不会替你开始录音。
        case recorder
        case detail(String)
    }

    /// `leophoneagent://recordings[/recorder|/import]`。只打开页面、导入分享来的音频;
    /// 不会因为一条链接就打开麦克风。
    static func handleDeepLink(path: String) {
        switch path {
        case "import":
            Task { @MainActor in
                let ids = await RecordingController.shared.importPendingShares()
                present(ids.first.map { .detail($0) } ?? .list)
            }
        case "recorder":
            present(.recorder)
        default:
            present(.list)
        }
    }

    static func present(_ start: Start = .list) {
        // 已经开着:不重复弹,按需切到对应页。
        if let presented, presented.presentingViewController != nil {
            RecordingNavigation.shared.request(start)
            return
        }
        guard let top = topViewController() else { return }
        let navigation = RecordingNavigation.shared
        navigation.reset(start)
        let host = UIHostingController(rootView: RecordingRootView(onClose: { dismiss() })
            .environmentObject(navigation))
        host.modalPresentationStyle = .pageSheet
        if let sheet = host.sheetPresentationController {
            sheet.detents = [.large()]
            sheet.prefersGrabberVisible = true
        }
        presented = host
        top.present(host, animated: true)
    }

    static func dismiss(completion: (() -> Void)? = nil) {
        guard let presented else { completion?(); return }
        presented.dismiss(animated: true, completion: completion)
        self.presented = nil
    }

    /// 关掉录音页再打开一个对话(生成的纪要)。
    static func openSession(_ sessionId: String) {
        dismiss {
            NotificationNavigationStore.shared.setPending(sessionId)
            NotificationCenter.default.post(name: .openSessionFromIntent, object: nil, userInfo: ["sessionId": sessionId])
        }
    }

    private static func topViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
            ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let root = scene.windows.first(where: { $0.windowLevel == .normal && !$0.isHidden })?.rootViewController
        else { return nil }
        var top = root
        while let next = top.presentedViewController { top = next }
        return top
    }
}

/// [V-rec] 录音页内的导航状态(列表 → 录音中 / 详情)。
@MainActor
final class RecordingNavigation: ObservableObject {
    static let shared = RecordingNavigation()

    enum Route: Hashable {
        case recorder
        case detail(String)
    }

    @Published var path: [Route] = []

    func reset(_ start: RecordingPresenter.Start) {
        path = []
        request(start)
    }

    func request(_ start: RecordingPresenter.Start) {
        switch start {
        case .list:
            break
        case .recorder:
            if RecordingController.shared.isRecording { path = [.recorder] }
        case .detail(let id):
            path = [.detail(id)]
        }
    }
}

/// 录音页的根:列表 + 导航。
struct RecordingRootView: View {
    let onClose: () -> Void
    @EnvironmentObject private var navigation: RecordingNavigation

    var body: some View {
        NavigationStack(path: $navigation.path) {
            RecordingListView(onClose: onClose)
                .navigationDestination(for: RecordingNavigation.Route.self) { route in
                    switch route {
                    case .recorder:
                        RecordingRecorderView()
                    case .detail(let id):
                        RecordingDetailView(recordingId: id)
                    }
                }
        }
    }
}
