import XCTest

final class QuickTaskCatalogTests: XCTestCase {
    func testBuiltInIdentifiersMatchLegacyAppEnumRawValues() {
        let legacyIDs = Set(QuickTask.allCases.map(\.rawValue))
        let entityIDs = Set(QuickTaskDefinition.builtIns.map(\.id))

        XCTAssertEqual(entityIDs, legacyIDs)
        XCTAssertEqual(entityIDs.count, 8)
    }

    @MainActor
    func testNormalizationPreservesEditsAndRestoresMissingBuiltIns() {
        var editedWeather = QuickTaskDefinition.builtIn(id: "checkWeather")!
        editedWeather.name = "Weather Before Leaving"
        editedWeather.prompt = "Check the weather and tell me whether to take an umbrella"
        editedWeather.isBuiltIn = false
        editedWeather.sortOrder = 0

        let custom = QuickTaskDefinition(
            id: "custom.test",
            name: "Prepare Meeting",
            prompt: "Read my next meeting and prepare talking points",
            symbolName: "calendar",
            isBuiltIn: true,
            sortOrder: 1
        )

        let normalized = QuickTaskStore.normalized([editedWeather, custom])

        XCTAssertEqual(normalized.count, 9)
        XCTAssertEqual(normalized.first?.name, "Weather Before Leaving")
        XCTAssertTrue(normalized.first?.isBuiltIn == true)
        XCTAssertFalse(normalized.first(where: { $0.id == custom.id })!.isBuiltIn)
        XCTAssertNotNil(normalized.first(where: { $0.id == "analyzeSleep" }))
        XCTAssertEqual(normalized.map(\.sortOrder), Array(0..<normalized.count))
    }

    @MainActor
    func testCustomTaskLifecyclePersistsWithoutDeletingBuiltIns() throws {
        let suiteName = "QuickTaskCatalogTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let store = QuickTaskStore(defaults: defaults)
        let created = try XCTUnwrap(store.add(
            name: "  Prepare Meeting  ",
            prompt: "  Review the next calendar event  ",
            symbolName: "calendar"
        ))

        XCTAssertEqual(created.name, "Prepare Meeting")
        XCTAssertEqual(created.prompt, "Review the next calendar event")
        XCTAssertEqual(store.tasks.count, 9)

        var edited = created
        edited.name = "Meeting Brief"
        store.update(edited)
        XCTAssertEqual(store.definition(for: created.id)?.name, "Meeting Brief")

        store.delete(id: "analyzeSleep")
        XCTAssertNotNil(store.definition(for: "analyzeSleep"))

        store.delete(id: created.id)
        XCTAssertNil(store.definition(for: created.id))
        XCTAssertEqual(store.tasks.count, 8)

        let reloaded = QuickTaskStore(defaults: defaults)
        XCTAssertEqual(reloaded.tasks.count, 8)
        XCTAssertNotNil(reloaded.definition(for: "checkWeather"))
    }
}
