import Combine
import XCTest

/// [up3-ios] 快捷动作流程:`$state` 在 willSet 时发出,订阅者同一轮回调里读到的还是旧状态。
/// AIChatView 的观察者(QuickActionObserverModifier)以前同步回调,照片 / 文件 / 语音 / 预填这些
/// 立即调 markCoverPresented() 的动作被 guard 挡掉,流程卡在 waitingForChatMount。
@MainActor
final class QuickActionWorkflowTests: XCTestCase {
    private var subscription: AnyCancellable?

    override func tearDown() {
        subscription = nil
        QuickActionWorkflow.shared.reset(reason: "test teardown")
        super.tearDown()
    }

    /// 和 AIChatView 一样接线:等挂载 → markChatReady;收到动作 → 立刻收尾(选择器 / 语音 / 预填没有封面回调)。
    private func observeLikeChatView(sessionId: String, applied: @escaping (ChatLaunchAction) -> Void,
                                     onState: @escaping (QuickActionWorkflow.State) -> Void) {
        let workflow = QuickActionWorkflow.shared
        subscription = workflow.$state.sink { state in
            onState(state)
            workflow.deliver(state, to: sessionId, onWaitingMatch: {
                if case .waitingForChatMount(_, let target) = workflow.state, target == sessionId {
                    workflow.markChatReady(sessionId: sessionId)
                }
            }, onChatReady: { action in
                applied(action)
                workflow.markCoverPresented()
            })
        }
    }

    func testImmediateCompletionActionsReturnToIdleThroughStateSubscriber() {
        for action: ChatLaunchAction in [.pickPhotos, .pickFiles, .startVoice, .prefillPrompt("hi")] {
            let workflow = QuickActionWorkflow.shared
            workflow.reset(reason: "test start")
            let sessionId = "draft-\(UUID().uuidString)"
            var applied: [ChatLaunchAction] = []
            var sawCover = false
            let backToIdle = expectation(description: "\(action) back to idle")
            observeLikeChatView(sessionId: sessionId, applied: { applied.append($0) }) { state in
                if case .coverPresenting = state { sawCover = true }
                if sawCover, case .idle = state { backToIdle.fulfill() }
            }

            workflow.start(action)
            workflow.markHome()
            workflow.attachTargetSession(sessionId)

            wait(for: [backToIdle], timeout: 3)
            XCTAssertEqual(applied, [action], "动作只投递一次,重试计时器不能再弹一次")
            XCTAssertEqual(workflow.state, .idle)
            subscription = nil
        }
    }

    func testDeliveryIsDroppedWhenStateMovedOn() {
        let workflow = QuickActionWorkflow.shared
        workflow.reset(reason: "test start")
        workflow.start(.openCamera)
        workflow.markHome()
        workflow.attachTargetSession("s1")
        workflow.markChatReady(sessionId: "s1")
        var delivered = false
        workflow.deliver(.chatReady(.openCamera, targetSessionId: "s1"), to: "s1",
                         onWaitingMatch: {}, onChatReady: { _ in delivered = true })
        workflow.reset(reason: "user left")
        let turn = expectation(description: "next main turn")
        DispatchQueue.main.async { turn.fulfill() }
        wait(for: [turn], timeout: 1)
        XCTAssertFalse(delivered, "下一轮时状态已经不是投递时的那个,不再执行")
    }
}
