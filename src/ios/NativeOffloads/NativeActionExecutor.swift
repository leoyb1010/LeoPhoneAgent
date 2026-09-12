import EventKit
import Foundation
import Photos
import UIKit

/// One native path for chat, home and system entry points; no model or iSH is required.
@MainActor
enum NativeActionExecutor {
    static func execute(_ route: ActionRouter.Decision, imageURL: URL? = nil, sessionId: String? = nil) async -> ActionRouter.ExecutionResult? {
        let plannedDate = route.hour.flatMap { hour in
            route.minute.flatMap { nativeDate(hour: hour, minute: $0, dayOffset: route.effectiveDayOffset) }
        }
        let requests: [(command: String, action: String, arguments: [String])]
        let schedule = ["--title", route.label, "--start", plannedDate?.ISO8601Format() ?? "none",
                        "--notes", route.notes, "--location", route.location]
        switch route.kind {
        case .savePhoto: requests = [("apple-photos", "import", [imageURL?.path ?? ""])]
        case .setAlarm: requests = [("apple-alarm", "set", schedule)]
        case .createCalendar: requests = [("apple-calendar", "create", schedule)]
        case .createTravel:
            requests = [("apple-calendar", "create", schedule), ("apple-reminders", "create", schedule)]
        case .createTodo: requests = [("apple-reminders", "create", schedule)]
        case .toggleFlashlight: requests = [("apple-device", "torch", ["--set", route.label])]
        case .readClipboard: requests = [("apple-clipboard", "get", [])]
        case .writeClipboard: requests = [("apple-clipboard", "set", [route.label])]
        case .deviceInfo: requests = [("apple-device", "info", [])]
        case nil: return nil
        }
        // Approve all parts before the first write of a compound action.
        for request in requests {
            let decision = await OffloadPermissionManager.shared.authorize(
                command: request.command, action: request.action,
                arguments: request.arguments, sessionId: sessionId)
            guard decision == .allowed else {
                return .init(text: decision.message(command: request.command) ?? "操作未授权。",
                             outcome: decision == .cancelled ? .cancelled
                                : decision == .needsForeground ? .waitingForUser : .failed)
            }
        }
        guard !Task.isCancelled else { return .init(text: AgentRunOutcome.cancelled.summary, outcome: .cancelled) }
        switch route.kind {
        case .savePhoto:
            guard let imageURL, await saveImageToPhotos(imageURL) else {
                return route.executionFailure(nextStep: "请检查所选图片和相册权限后重试。")
            }
            return route.executionSuccess()
        case .setAlarm:
            guard let plannedDate, plannedDate > Date() else {
                return .init(text: "请选择一个未来的闹钟时间。", outcome: .waitingForUser)
            }
            guard await scheduleNativeAlarm(fire: plannedDate, label: route.label) else {
                return route.executionFailure(nextStep: "请检查系统时钟或闹钟权限后重试")
            }
            return route.executionSuccess()
        case .createCalendar:
            guard let plannedDate else { return nil }
            guard await createNativeEvent(start: plannedDate, title: route.label, notes: route.notes, location: route.location) else {
                return route.executionFailure(nextStep: "请授权日历访问后重试")
            }
            return route.executionSuccess()
        case .createTravel:
            guard let plannedDate else { return nil }
            guard await createNativeEvent(start: plannedDate, title: route.label, notes: route.notes, location: route.location) else {
                return route.executionFailure(nextStep: "日程未能创建，请检查日历权限后重试。")
            }
            guard await saveReminder(route.label, dueDate: plannedDate, notes: route.notes) else {
                return .init(text: "日程已创建，但提醒事项尚未确认。请先检查系统日历和提醒事项，避免重复创建。", outcome: .unknown)
            }
            return route.executionSuccess()
        case .toggleFlashlight:
            do {
                _ = try await DeviceActions.shared.setTorch(enabled: route.label != "off")
                return route.executionSuccess()
            } catch let error as DeviceActionError {
                return .init(text: error.message,
                             outcome: error.code == "state_unconfirmed" ? .unknown
                                : error.code == "cancelled" ? .cancelled : .failed)
            } catch {
                return route.executionFailure(nextStep: "系统未能设置手电筒，请刷新状态后重试。")
            }
        case .createTodo:
            return await saveReminder(route.label.isEmpty ? "待办" : route.label, dueDate: plannedDate, notes: route.notes)
                ? route.executionSuccess()
                : route.executionFailure(nextStep: "请授权提醒事项后重试")
        case .readClipboard:
            let text = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return route.executionSuccess(summary: text.isEmpty ? "剪贴板是空的。" : "剪贴板内容：\n\(String(text.prefix(4_000)))")
        case .writeClipboard:
            UIPasteboard.general.string = route.label
            guard UIPasteboard.general.string == route.label else {
                return route.executionFailure(nextStep: "系统没有读回相同内容，请重试")
            }
            return route.executionSuccess(summary: "已写入剪贴板，并读回核对成功。")
        case .deviceInfo:
            let device = UIDevice.current
            device.isBatteryMonitoringEnabled = true
            let battery = device.batteryLevel >= 0 ? "\(Int(device.batteryLevel * 100))%" : "未知"
            return route.executionSuccess(summary: "本机设备信息：\n型号：\(device.model)\n系统：\(device.systemName) \(device.systemVersion)\n电量：\(battery)")
        case nil:
            return nil
        }
    }

    private static func saveImageToPhotos(_ url: URL) async -> Bool {
        let granted: Bool = await withCheckedContinuation { cont in
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                cont.resume(returning: status == .authorized || status == .limited)
            }
        }
        guard granted, !Task.isCancelled else { return false }
        return await withCheckedContinuation { cont in
            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAssetFromImage(atFileURL: url)
            }, completionHandler: { ok, _ in
                cont.resume(returning: ok)
            })
        }
    }

    private static func scheduleNativeAlarm(fire: Date, label: String) async -> Bool {
        if #available(iOS 26.0, *) {
            return await withCheckedContinuation { cont in
                AlarmOffloadBridge.scheduleAlarm(
                    withId: UUID().uuidString,
                    fireDate: fire,
                    label: label.isEmpty ? "闹钟" : label,
                    repeatMode: "once"
                ) { _, error in
                    cont.resume(returning: error == nil)
                }
            }
        }
        return false
    }

    private static func nativeDate(hour: Int, minute: Int, dayOffset: Int) -> Date? {
        let now = Date()
        var comps = Calendar.current.dateComponents([.year, .month, .day], from: now)
        if dayOffset > 0, let day = Calendar.current.date(byAdding: .day, value: dayOffset, to: now) {
            comps = Calendar.current.dateComponents([.year, .month, .day], from: day)
        }
        comps.hour = hour
        comps.minute = minute
        return Calendar.current.date(from: comps)
    }

    private static func createNativeEvent(
        start: Date,
        title: String,
        notes: String = "",
        location: String = ""
    ) async -> Bool {
        let store = EKEventStore()
        let granted: Bool
        if #available(iOS 17.0, *) {
            granted = (try? await store.requestFullAccessToEvents()) ?? false
        } else {
            granted = await withCheckedContinuation { cont in
                store.requestAccess(to: .event) { ok, _ in cont.resume(returning: ok) }
            }
        }
        guard granted, !Task.isCancelled else { return false }
        let ev = EKEvent(eventStore: store)
        ev.title = title.isEmpty ? "日程" : title
        ev.startDate = start
        ev.endDate = start.addingTimeInterval(3600)
        ev.notes = notes.isEmpty ? nil : notes
        ev.location = location.isEmpty ? nil : location
        ev.addAlarm(EKAlarm(relativeOffset: -30 * 60))
        ev.calendar = store.defaultCalendarForNewEvents
        do {
            try store.save(ev, span: .thisEvent)
            guard let identifier = ev.eventIdentifier,
                  let saved = store.event(withIdentifier: identifier) else { return false }
            return saved.title == ev.title && abs(saved.startDate.timeIntervalSince(start)) < 1
        } catch {
            return false
        }
    }

    private static func saveReminder(_ title: String, dueDate: Date? = nil, notes: String = "") async -> Bool {
        let store = EKEventStore()
        let granted: Bool
        if #available(iOS 17.0, *) {
            granted = (try? await store.requestFullAccessToReminders()) ?? false
        } else {
            granted = await withCheckedContinuation { cont in
                store.requestAccess(to: .reminder) { ok, _ in cont.resume(returning: ok) }
            }
        }
        guard granted, !Task.isCancelled else { return false }
        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        reminder.notes = notes.isEmpty ? nil : notes
        if let dueDate {
            reminder.dueDateComponents = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute],
                from: dueDate
            )
            reminder.addAlarm(EKAlarm(absoluteDate: dueDate.addingTimeInterval(-30 * 60)))
        }
        reminder.calendar = store.defaultCalendarForNewReminders()
        do {
            try store.save(reminder, commit: true)
            guard let saved = store.calendarItem(withIdentifier: reminder.calendarItemIdentifier) as? EKReminder else {
                return false
            }
            return saved.title == reminder.title && saved.dueDateComponents == reminder.dueDateComponents
        } catch {
            return false
        }
    }
}
