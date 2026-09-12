import Foundation
import WidgetKit

private let logger = AppLogger(category: "QuickTaskWidget")

enum QuickTaskWidgetRunner {
    @MainActor private static var dispatching: Set<String> = []

    @discardableResult
    @MainActor
    static func run(taskId: String) async -> Bool {
        guard let definition = QuickTaskStore.shared.definition(for: taskId) else {
            WidgetQuickTasksStore.updateRunState(id: taskId, state: .failed)
            reload()
            return false
        }
        guard dispatching.insert(taskId).inserted else { return false }
        defer { dispatching.remove(taskId) }

        let requestId = UUID().uuidString
        WidgetQuickTasksStore.beginRun(id: taskId, requestId: requestId)
        reload()
        do {
            let result = try await QuickTaskIntent.execute(
                definition: definition, files: nil, model: nil,
                waitForResult: false, inputValues: [:]
            )
            guard let value = result.value, !value.sessionId.isEmpty, !value.runId.isEmpty else {
                WidgetQuickTasksStore.updateRunState(id: taskId, state: .unknown, requestId: requestId)
                reload()
                return true
            }
            let sessionId = value.sessionId
            let runId = value.runId
            WidgetQuickTasksStore.bindRun(id: taskId, requestId: requestId,
                                         runId: runId, sessionId: sessionId)
            WidgetPendingBriefingStore.add(sessionId: sessionId, taskName: definition.displayName,
                                           runId: runId, taskId: taskId)
            Task { @MainActor in
                let outcome = await SendPromptIntent.waitForRun(runId: runId)
                WidgetQuickTasksStore.updateRunState(id: taskId, state: badgeState(for: outcome),
                                                    requestId: requestId, runId: runId)
                reload()
                // The durable pending record survives observer timeout/process
                // suspension; only a matching successful receipt may publish it.
                await WidgetDataMirror.resolvePendingBriefings(reason: "widgetObserver")
                await WidgetDataMirror.refreshAll()
            }
            return true
        } catch {
            WidgetQuickTasksStore.updateRunState(
                id: taskId, state: error is CancellationError ? .cancelled : .failed,
                requestId: requestId
            )
            reload()
            logger.error("Widget task did not start")
            return false
        }
    }

    static func badgeState(for outcome: AgentRunOutcome) -> WidgetQuickTaskItem.RunState {
        switch outcome {
        case .succeeded: .succeeded
        case .failed: .failed
        case .cancelled: .cancelled
        case .suspended: .suspended
        case .waitingForUser, .awaitingApproval: .waitingForUser
        case .running: .running
        case .unknown: .unknown
        }
    }

    private static func reload() {
        WidgetCenter.shared.reloadTimelines(ofKind: LeoWidgetKind.quickTasks)
        WidgetCenter.shared.reloadTimelines(ofKind: LeoWidgetKind.iPadConsole)
    }
}
