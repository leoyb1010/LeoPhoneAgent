import AppIntents
import Combine
import Foundation

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

struct QuickTaskDefinition: Codable, Identifiable, Hashable, Sendable {
    var id: String
    var name: String
    var prompt: String
    var symbolName: String
    var isBuiltIn: Bool
    var sortOrder: Int

    static let builtIns: [QuickTaskDefinition] = [
        .init(
            id: "analyzeSleep",
            name: "Analyze Sleep",
            prompt: "Read my recent sleep data (apple-healthkit sleep), analyze sleep quality and generate a report",
            symbolName: "bed.double.fill",
            isBuiltIn: true,
            sortOrder: 0
        ),
        .init(
            id: "healthReport",
            name: "Health Report",
            prompt: "Read my health data for today: steps (apple-healthkit steps --today), heart rate (apple-healthkit heart-rate --today), blood oxygen, and generate a daily health report",
            symbolName: "heart.text.square.fill",
            isBuiltIn: true,
            sortOrder: 1
        ),
        .init(
            id: "checkWeather",
            name: "Check Weather",
            prompt: "Check today's weather (apple-weather) and give clothing and travel suggestions",
            symbolName: "cloud.sun.fill",
            isBuiltIn: true,
            sortOrder: 2
        ),
        .init(
            id: "morningBriefing",
            name: "Morning Briefing",
            prompt: "Give me a morning briefing for today: first check the weather (apple-weather), then check today's calendar events (apple-calendar), finally search for important news today using the browser, and summarize into a briefing",
            symbolName: "sunrise.fill",
            isBuiltIn: true,
            sortOrder: 3
        ),
        .init(
            id: "checkCalendar",
            name: "Check Calendar",
            prompt: "Check my schedule for today and tomorrow (apple-calendar)",
            symbolName: "calendar",
            isBuiltIn: true,
            sortOrder: 4
        ),
        .init(
            id: "takePhoto",
            name: "Take Photo",
            prompt: "Take a photo using the device camera (apple-media camera) and describe what was captured",
            symbolName: "camera.fill",
            isBuiltIn: true,
            sortOrder: 5
        ),
        .init(
            id: "setAlarm",
            name: "Set Alarm",
            prompt: "Set an alarm to remind me in 5 minutes",
            symbolName: "alarm.fill",
            isBuiltIn: true,
            sortOrder: 6
        ),
        .init(
            id: "controlHome",
            name: "Control Home",
            prompt: "List the status of my HomeKit smart home devices (apple-homekit list)",
            symbolName: "house.fill",
            isBuiltIn: true,
            sortOrder: 7
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

    @Published private(set) var tasks: [QuickTaskDefinition]

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.storageKey),
           let decoded = try? JSONDecoder().decode([QuickTaskDefinition].self, from: data) {
            self.tasks = Self.normalized(decoded)
        } else {
            self.tasks = QuickTaskDefinition.builtIns
        }
        persist(notifyShortcuts: false)
    }

    func definition(for id: String) -> QuickTaskDefinition? {
        tasks.first { $0.id == id } ?? QuickTaskDefinition.builtIn(id: id)
    }

    @discardableResult
    func add(name: String, prompt: String, symbolName: String = "bolt.fill") -> QuickTaskDefinition? {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty, !trimmedPrompt.isEmpty else { return nil }

        let definition = QuickTaskDefinition(
            id: "custom.\(UUID().uuidString.lowercased())",
            name: trimmedName,
            prompt: trimmedPrompt,
            symbolName: symbolName,
            isBuiltIn: false,
            sortOrder: tasks.count
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
        resequence()
        persist()
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
            result.append(item)
        }

        let existingIDs = Set(result.map(\.id))
        result.append(contentsOf: QuickTaskDefinition.builtIns.filter { !existingIDs.contains($0.id) })
        for index in result.indices {
            result[index].sortOrder = index
        }
        return result
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
