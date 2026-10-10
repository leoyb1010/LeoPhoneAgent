import Foundation

// [F2-memory-undo] App glue for「撤销这条记忆」on a memory_write capsule.

@MainActor
enum MemoryUndoAction {
    static func target(for block: AssistantBlock) -> MemoryWriteUndo.Target? {
        guard case .memoryTool(let action) = block.kind, action == "memory_write" else { return nil }
        return MemoryWriteUndo.target(toolName: action, inputArgs: block.toolInputArgs, output: block.content)
    }

    static func canUndo(_ block: AssistantBlock) -> Bool { target(for: block) != nil }

    static func undo(_ block: AssistantBlock) {
        guard let target = target(for: block) else { return }
        let removed: Bool
        switch target {
        case .correction(let content):
            removed = CorrectionStore.remove(content)
        case .daily(let fileName, let content):
            let dir = AIChatViewModel.minisMemoryPersistentDir
            removed = (try? MemoryDailyLog.removeEntry(matching: content, fileName: fileName, in: dir)) ?? false
            if removed {
                let stem = (fileName as NSString).deletingPathExtension
                Task { await ChatStore.shared.markDirty(recordType: "MemoryDailyV2", recordId: stem) }
                NotificationCenter.default.post(name: .memoryFilesDidChange, object: nil)
                WidgetDataMirror.refreshMemory()
            }
        }
        if removed {
            LeoHaptics.notification(.success)
            MinisToast.show(String(localized: "已撤销这条记忆"))
        } else {
            LeoHaptics.notification(.warning)
            MinisToast.show(String(localized: "没找到这条记忆,可能已经删除或被修改"))
        }
    }
}
