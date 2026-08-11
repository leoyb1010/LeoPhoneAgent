import AppIntents
import Combine
import Foundation
import WidgetKit

/// Locale-aware presentation for Token counts. The product term remains
/// "Token" in labels; only the numeric abbreviation follows the selected
/// app/system locale (for example, 12,345 -> 1.2万 in Simplified Chinese).
enum LeoTokenCountFormatter {
    static func compact(_ count: Int, locale: Locale) -> String {
        count.formatted(.number.locale(locale).notation(.compactName))
    }
}

/// Compatibility enum for shortcuts saved before 1.0.12.
/// New shortcuts use `QuickTaskEntity`, but this type and its raw identifiers
/// must remain stable for existing user automations.
enum QuickTask: String, AppEnum {
    case analyzeSleep
    case healthReport
    case checkWeather
    case morningBriefing
    case checkCalendar
    case takePhoto
    case setAlarm
    case controlHome

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Quick Task")

    static let caseDisplayRepresentations: [QuickTask: DisplayRepresentation] = [
        .analyzeSleep: DisplayRepresentation(title: "Analyze Sleep", subtitle: "分析睡眠"),
        .healthReport: DisplayRepresentation(title: "Health Report", subtitle: "健康报告"),
        .checkWeather: DisplayRepresentation(title: "Check Weather", subtitle: "查看天气"),
        .morningBriefing: DisplayRepresentation(title: "Morning Briefing", subtitle: "早间简报"),
        .checkCalendar: DisplayRepresentation(title: "Check Calendar", subtitle: "查看日程"),
        .takePhoto: DisplayRepresentation(title: "Take Photo", subtitle: "拍照"),
        .setAlarm: DisplayRepresentation(title: "Set Alarm", subtitle: "设置闹钟"),
        .controlHome: DisplayRepresentation(title: "Control Home", subtitle: "智能家居"),
    ]

    var prompt: String {
        QuickTaskDefinition.builtIn(id: rawValue)?.prompt ?? ""
    }
}

extension Notification.Name {
    static let quickTaskCatalogDidChange = Notification.Name("leo.quickTaskCatalogDidChange")
}

enum QuickTaskOutputMode: String, Codable, CaseIterable, Hashable, Sendable {
    case automatic
    case conciseText
    case markdown
    case json
    case artifact

    var title: String {
        switch self {
        case .automatic: return "Automatic"
        case .conciseText: return "Concise Text"
        case .markdown: return "Markdown"
        case .json: return "JSON"
        case .artifact: return "Saved Artifact"
        }
    }

    var promptInstruction: String? {
        switch self {
        case .automatic: return nil
        case .conciseText: return "Return a concise plain-text result without decorative formatting."
        case .markdown: return "Return a well-structured Markdown result with useful headings and lists."
        case .json: return "Return one valid JSON object only, without Markdown fences or commentary."
        case .artifact: return "Save the final result as a file in /var/minis/workspace/ and briefly name the created artifact."
        }
    }
}

struct QuickTaskDefinition: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var prompt: String
    var symbolName: String
    var isBuiltIn: Bool
    var sortOrder: Int
    var outputMode: QuickTaskOutputMode

    /// Built-in names are stable persisted identifiers but should be presented
    /// in the active UI language. A user-edited built-in or custom task keeps
    /// the exact name the user entered.
    var displayName: String {
        guard isBuiltIn,
              let original = Self.builtIn(id: id),
              name == original.name else { return name }
        return String(localized: String.LocalizationValue(name))
    }

    init(
        id: String,
        name: String,
        prompt: String,
        symbolName: String,
        isBuiltIn: Bool,
        sortOrder: Int,
        outputMode: QuickTaskOutputMode = .automatic
    ) {
        self.id = id
        self.name = name
        self.prompt = prompt
        self.symbolName = symbolName
        self.isBuiltIn = isBuiltIn
        self.sortOrder = sortOrder
        self.outputMode = outputMode
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, prompt, symbolName, isBuiltIn, sortOrder, outputMode
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        prompt = try container.decode(String.self, forKey: .prompt)
        symbolName = try container.decode(String.self, forKey: .symbolName)
        isBuiltIn = try container.decode(Bool.self, forKey: .isBuiltIn)
        sortOrder = try container.decode(Int.self, forKey: .sortOrder)
        outputMode = try container.decodeIfPresent(QuickTaskOutputMode.self, forKey: .outputMode) ?? .automatic
    }

    var inputSlotNames: [String] {
        let pattern = #"\{\{\s*([A-Za-z][A-Za-z0-9_-]{0,31})\s*\}\}"#
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(prompt.startIndex..<prompt.endIndex, in: prompt)
        var seen = Set<String>()
        return expression.matches(in: prompt, range: range).compactMap { match in
            guard let slotRange = Range(match.range(at: 1), in: prompt) else { return nil }
            let name = String(prompt[slotRange])
            return seen.insert(name).inserted ? name : nil
        }
    }

    func renderedPrompt(inputValues: [String: String] = [:]) -> String {
        var rendered = prompt
        for name in inputSlotNames {
            let markerPattern = #"\{\{\s*"# + NSRegularExpression.escapedPattern(for: name) + #"\s*\}\}"#
            let value = inputValues[name]?.trimmingCharacters(in: .whitespacesAndNewlines)
            let replacement = value.flatMap { $0.isEmpty ? nil : $0 } ?? "[Input required: \(name)]"
            rendered = rendered.replacingOccurrences(
                of: markerPattern,
                with: NSRegularExpression.escapedTemplate(for: replacement),
                options: .regularExpression
            )
        }
        if let instruction = outputMode.promptInstruction {
            rendered += "\n\nOutput requirement: \(instruction)"
        }
        return rendered
    }

    static let builtIns: [QuickTaskDefinition] = [
        .init(
            id: "morningBriefing",
            name: "早间简报",
            prompt: "给我做今天的早间简报：先查询天气（apple-weather），再查看今天的日程安排（apple-calendar），最后用浏览器搜索今天的重要新闻，汇总成一份简洁的中文简报。",
            symbolName: "sunrise.fill",
            isBuiltIn: true,
            sortOrder: 0
        ),
        .init(
            id: "dailyNews",
            name: "今日热点",
            prompt: "用浏览器搜索今天国内外的重要新闻和热点事件，筛选出最重要的 5-8 条，按「标题 + 一句话摘要」的格式输出一份中文热点简报。",
            symbolName: "newspaper.fill",
            isBuiltIn: true,
            sortOrder: 1
        ),
        .init(
            id: "clipboardAssistant",
            name: "剪贴板速办",
            prompt: "读取我的剪贴板内容（apple-clipboard get），判断内容类型并处理：外文则翻译成中文；链接则用浏览器打开并总结要点；待办类内容则整理成清单并写入提醒事项（apple-reminders create）；其他内容给出简明摘要和建议。",
            symbolName: "doc.on.clipboard.fill",
            isBuiltIn: true,
            sortOrder: 2
        ),
        .init(
            id: "checkWeather",
            name: "查看天气",
            prompt: "查询今天的天气（apple-weather），用中文给出穿衣和出行建议。",
            symbolName: "cloud.sun.fill",
            isBuiltIn: true,
            sortOrder: 3
        ),
        .init(
            id: "checkCalendar",
            name: "查看日程",
            prompt: "查看我今天和明天的日程安排（apple-calendar），用中文按时间顺序清晰列出，并提示可能的时间冲突。",
            symbolName: "calendar",
            isBuiltIn: true,
            sortOrder: 4
        ),
        .init(
            id: "eveningReview",
            name: "晚间回顾",
            prompt: "帮我做今日晚间回顾：查看今天剩余和明天的日程（apple-calendar），检查未完成的提醒事项（apple-reminders list），查询明天的天气（apple-weather），最后汇总成一份简洁的中文晚间总结，并给出明天的准备建议。",
            symbolName: "moon.stars.fill",
            isBuiltIn: true,
            sortOrder: 5
        ),
        .init(
            id: "photoOCR",
            name: "拍照识字",
            prompt: "调用相机拍一张照片（apple-media camera），用 OCR 识别照片中的文字（apple-vision ocr），输出识别出的完整文字；如果是外文，同时给出中文翻译。",
            symbolName: "text.viewfinder",
            isBuiltIn: true,
            sortOrder: 6
        ),
        .init(
            id: "nearbyExplore",
            name: "附近探索",
            prompt: "获取我的当前位置（apple-location current），搜索附近值得去的餐厅、咖啡店或景点（apple-maps search），用中文推荐 3-5 个，说明各自的特色和大致距离。",
            symbolName: "location.magnifyingglass",
            isBuiltIn: true,
            sortOrder: 7
        ),
        .init(
            id: "analyzeSleep",
            name: "分析睡眠",
            prompt: "读取我最近的睡眠数据（apple-healthkit sleep），分析睡眠质量并生成一份中文睡眠报告，给出改善建议。",
            symbolName: "bed.double.fill",
            isBuiltIn: true,
            sortOrder: 8
        ),
        .init(
            id: "healthReport",
            name: "健康日报",
            prompt: "读取我今天的健康数据：步数（apple-healthkit steps --today）、心率（apple-healthkit heart-rate --today）、血氧等，生成一份中文的今日健康日报。",
            symbolName: "heart.text.square.fill",
            isBuiltIn: true,
            sortOrder: 9
        ),
        .init(
            id: "takePhoto",
            name: "拍照描述",
            prompt: "用设备相机拍一张照片（apple-media camera），并用中文描述拍到的内容。",
            symbolName: "camera.fill",
            isBuiltIn: true,
            sortOrder: 10
        ),
        .init(
            id: "setAlarm",
            name: "设置闹钟",
            prompt: "设置一个 5 分钟后提醒我的闹钟。",
            symbolName: "alarm.fill",
            isBuiltIn: true,
            sortOrder: 11
        ),
        .init(
            id: "controlHome",
            name: "智能家居",
            prompt: "列出我的 HomeKit 智能家居设备状态（apple-homekit list），用中文汇总当前家里各设备的情况。",
            symbolName: "house.fill",
            isBuiltIn: true,
            sortOrder: 12
        ),
    ]

    /// Pre-1.1.3 built-in defaults (English). A persisted built-in whose
    /// name/prompt still equals the old default was never edited by the user,
    /// so it is silently upgraded to the current Chinese default in
    /// `QuickTaskStore.normalized`. User-edited copies are left untouched.
    static let legacyBuiltInDefaults: [String: (name: String, prompt: String)] = [
        "analyzeSleep": (
            "Analyze Sleep",
            "Read my recent sleep data (apple-healthkit sleep), analyze sleep quality and generate a report"
        ),
        "healthReport": (
            "Health Report",
            "Read my health data for today: steps (apple-healthkit steps --today), heart rate (apple-healthkit heart-rate --today), blood oxygen, and generate a daily health report"
        ),
        "checkWeather": (
            "Check Weather",
            "Check today's weather (apple-weather) and give clothing and travel suggestions"
        ),
        "morningBriefing": (
            "Morning Briefing",
            "Give me a morning briefing for today: first check the weather (apple-weather), then check today's calendar events (apple-calendar), finally search for important news today using the browser, and summarize into a briefing"
        ),
        "checkCalendar": (
            "Check Calendar",
            "Check my schedule for today and tomorrow (apple-calendar)"
        ),
        "takePhoto": (
            "Take Photo",
            "Take a photo using the device camera (apple-media camera) and describe what was captured"
        ),
        "setAlarm": (
            "Set Alarm",
            "Set an alarm to remind me in 5 minutes"
        ),
        "controlHome": (
            "Control Home",
            "List the status of my HomeKit smart home devices (apple-homekit list)"
        ),
    ]

    static func builtIn(id: String) -> QuickTaskDefinition? {
        builtIns.first { $0.id == id }
    }
}

@MainActor
final class QuickTaskStore: ObservableObject {
    static let shared = QuickTaskStore()

    static let storageKey = "leo.quickTasks.v1"
    static let composerTaskIDsKey = "leo.quickTasks.composerTaskIDs.v1"
    static let composerTaskLimit = 3
    /// Keep the first-run composer deliberately curated. Deriving this from
    /// catalog order made adding or reordering built-ins silently change the
    /// primary shortcuts presented to every new user.
    static let defaultComposerTaskIDs = [
        "morningBriefing",
        "dailyNews",
        "clipboardAssistant",
    ]

    @Published private(set) var tasks: [QuickTaskDefinition]
    @Published private(set) var composerTaskIDs: [String]

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let loadedTasks: [QuickTaskDefinition]
        if let data = defaults.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode([QuickTaskDefinition].self, from: data) {
            loadedTasks = Self.normalized(decoded)
        } else {
            loadedTasks = QuickTaskDefinition.builtIns
        }
        self.tasks = loadedTasks
        if let storedIDs = defaults.array(forKey: Self.composerTaskIDsKey) as? [String] {
            self.composerTaskIDs = Self.normalizedComposerTaskIDs(storedIDs, tasks: loadedTasks)
        } else {
            self.composerTaskIDs = Self.normalizedComposerTaskIDs(
                Self.defaultComposerTaskIDs,
                tasks: loadedTasks
            )
        }
        persist(notifyShortcuts: false)
        persistComposerTaskIDs()
    }

    var composerTasks: [QuickTaskDefinition] {
        composerTaskIDs.compactMap { definition(for: $0) }
    }

    func isPinnedToComposer(_ id: String) -> Bool {
        composerTaskIDs.contains(id)
    }

    /// Pins at most three stable task identifiers. Returns false only when a
    /// fourth task was requested; unpinning and idempotent pinning always work.
    @discardableResult
    func setComposerPinned(_ pinned: Bool, id: String) -> Bool {
        guard definition(for: id) != nil else { return false }
        if pinned {
            guard !composerTaskIDs.contains(id) else { return true }
            guard composerTaskIDs.count < Self.composerTaskLimit else { return false }
            composerTaskIDs.append(id)
        } else {
            composerTaskIDs.removeAll { $0 == id }
        }
        persistComposerTaskIDs()
        NotificationCenter.default.post(name: .quickTaskCatalogDidChange, object: nil)
        return true
    }

    func definition(for id: String) -> QuickTaskDefinition? {
        tasks.first { $0.id == id } ?? QuickTaskDefinition.builtIn(id: id)
    }

    @discardableResult
    func add(
        name: String,
        prompt: String,
        symbolName: String = "bolt.fill",
        outputMode: QuickTaskOutputMode = .automatic
    ) -> QuickTaskDefinition? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, !trimmedPrompt.isEmpty else { return nil }

        let definition = QuickTaskDefinition(
            id: "custom.\(UUID().uuidString.lowercased())",
            name: trimmedName,
            prompt: trimmedPrompt,
            symbolName: symbolName,
            isBuiltIn: false,
            sortOrder: tasks.count,
            outputMode: outputMode
        )
        tasks.append(definition)
        persist()
        return definition
    }

    func update(_ definition: QuickTaskDefinition) {
        guard let index = tasks.firstIndex(where: { $0.id == definition.id }) else { return }
        let trimmedName = definition.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPrompt = definition.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, !trimmedPrompt.isEmpty else { return }

        var updated = definition
        updated.name = trimmedName
        updated.prompt = trimmedPrompt
        updated.isBuiltIn = QuickTaskDefinition.builtIn(id: definition.id) != nil
        tasks[index] = updated
        persist()
    }

    func delete(id: String) {
        guard QuickTaskDefinition.builtIn(id: id) == nil else { return }
        tasks.removeAll { $0.id == id }
        composerTaskIDs.removeAll { $0 == id }
        resequence()
        persist()
        persistComposerTaskIDs()
    }

    func move(from source: IndexSet, to destination: Int) {
        var reordered = tasks
        let moving = source.map { reordered[$0] }
        for index in source.sorted(by: >) {
            reordered.remove(at: index)
        }
        let removedBeforeDestination = source.filter { $0 < destination }.count
        let insertionIndex = max(0, min(reordered.count, destination - removedBeforeDestination))
        reordered.insert(contentsOf: moving, at: insertionIndex)
        tasks = reordered
        resequence()
        persist()
    }

    func resetBuiltIns() {
        let customTasks = tasks.filter { QuickTaskDefinition.builtIn(id: $0.id) == nil }
        tasks = QuickTaskDefinition.builtIns + customTasks
        resequence()
        persist()
    }

    func exportData(id: String) -> Data? {
        guard let task = definition(for: id) else { return nil }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try? encoder.encode(task)
    }

    @discardableResult
    func importData(_ data: Data) -> QuickTaskDefinition? {
        guard var imported = try? JSONDecoder().decode(QuickTaskDefinition.self, from: data) else { return nil }
        imported.id = "custom.\(UUID().uuidString.lowercased())"
        imported.isBuiltIn = false
        imported.sortOrder = tasks.count
        let normalized = Self.normalized([imported]).first { $0.id == imported.id }
        guard var normalized else { return nil }
        normalized.sortOrder = tasks.count
        tasks.append(normalized)
        persist()
        return normalized
    }

    static func normalized(_ decoded: [QuickTaskDefinition]) -> [QuickTaskDefinition] {
        var seen = Set<String>()
        var result: [QuickTaskDefinition] = []

        for var item in decoded.sorted(by: { $0.sortOrder < $1.sortOrder }) {
            item.name = item.name.trimmingCharacters(in: .whitespacesAndNewlines)
            item.prompt = item.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !item.id.isEmpty,
                  !item.name.isEmpty,
                  !item.prompt.isEmpty,
                  seen.insert(item.id).inserted else { continue }
            item.isBuiltIn = QuickTaskDefinition.builtIn(id: item.id) != nil
            // Silently upgrade persisted built-ins that still carry the
            // pre-1.1.3 English defaults to the current Chinese defaults.
            // A name/prompt the user edited no longer matches the legacy
            // default and is left untouched.
            if item.isBuiltIn,
               let current = QuickTaskDefinition.builtIn(id: item.id),
               let legacy = QuickTaskDefinition.legacyBuiltInDefaults[item.id] {
                if item.name == legacy.name { item.name = current.name }
                if item.prompt == legacy.prompt { item.prompt = current.prompt }
            }
            result.append(item)
        }

        let existingIDs = Set(result.map(\.id))
        result.append(contentsOf: QuickTaskDefinition.builtIns.filter { !existingIDs.contains($0.id) })
        for index in result.indices {
            result[index].sortOrder = index
        }
        return result
    }

    static func normalizedComposerTaskIDs(
        _ ids: [String],
        tasks: [QuickTaskDefinition]
    ) -> [String] {
        let validIDs = Set(tasks.map(\.id))
        var seen = Set<String>()
        return ids.filter { validIDs.contains($0) && seen.insert($0).inserted }
            .prefix(Self.composerTaskLimit)
            .map { $0 }
    }

    private func resequence() {
        for index in tasks.indices {
            tasks[index].sortOrder = index
        }
    }

    private func persist(notifyShortcuts: Bool = true) {
        guard let data = try? JSONEncoder().encode(tasks) else { return }
        defaults.set(data, forKey: Self.storageKey)
        if notifyShortcuts {
            NotificationCenter.default.post(name: .quickTaskCatalogDidChange, object: nil)
        }
        syncWidgetSnapshot()
    }

    private func persistComposerTaskIDs() {
        defaults.set(composerTaskIDs, forKey: Self.composerTaskIDsKey)
        syncWidgetSnapshot()
    }

    /// [T-widget-quick-tasks] Mirror the catalog into the App Group for the
    /// Home Screen quick-task widget: composer-pinned tasks first, then the
    /// rest in list order, capped at 8. QuickTaskStore itself persists to
    /// UserDefaults.standard, which the widget process cannot read.
    private func syncWidgetSnapshot() {
        // [T-widget-runstate-wipe] Carry the existing run state across. This
        // rebuilds the whole table from the catalog, and the initialiser
        // defaults lastRunState to .idle — so before this merge, renaming or
        // reordering ANY quick task (and every cold launch, via
        // QuickTaskStore.init) erased the ⏳/✅ badges of tasks that were
        // running or had just finished.
        let previous = Dictionary(
            WidgetQuickTasksStore.load().map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        let pinned = composerTasks
        let pinnedIDs = Set(pinned.map(\.id))
        let ordered = pinned + tasks.filter { !pinnedIDs.contains($0.id) }
        let items = ordered.prefix(8).map { task -> WidgetQuickTaskItem in
            var item = WidgetQuickTaskItem(id: task.id, name: task.displayName, symbolName: task.symbolName)
            if let old = previous[task.id] {
                item.lastRunState = old.lastRunState
                item.lastRunAt = old.lastRunAt
            }
            return item
        }
        WidgetQuickTasksStore.save(Array(items))
        WidgetCenter.shared.reloadTimelines(ofKind: LeoWidgetKind.quickTasks)
    }
}

struct QuickTaskEntity: AppEntity, Hashable, Sendable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Quick Task")
    static let defaultQuery = QuickTaskEntityQuery()

    var id: String
    var name: String
    var prompt: String
    var symbolName: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: LocalizedStringResource(stringLiteral: name),
            subtitle: LocalizedStringResource(stringLiteral: String(prompt.prefix(80))),
            image: .init(systemName: symbolName)
        )
    }

    init(_ definition: QuickTaskDefinition) {
        id = definition.id
        name = definition.name
        prompt = definition.prompt
        symbolName = definition.symbolName
    }
}

struct QuickTaskEntityQuery: EntityQuery, EntityStringQuery {
    typealias Result = IntentItemCollection<QuickTaskEntity>

    @MainActor
    func entities(for identifiers: [String]) async throws -> [QuickTaskEntity] {
        identifiers.compactMap { id in
            QuickTaskStore.shared.definition(for: id).map(QuickTaskEntity.init)
        }
    }

    @MainActor
    func entities(matching string: String) async throws -> IntentItemCollection<QuickTaskEntity> {
        let query = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let matches = QuickTaskStore.shared.tasks.filter { task in
            query.isEmpty || task.name.lowercased().contains(query) || task.prompt.lowercased().contains(query)
        }
        return IntentItemCollection(items: matches.map(QuickTaskEntity.init))
    }

    @MainActor
    func suggestedEntities() async throws -> IntentItemCollection<QuickTaskEntity> {
        IntentItemCollection(items: QuickTaskStore.shared.tasks.map(QuickTaskEntity.init))
    }
}
