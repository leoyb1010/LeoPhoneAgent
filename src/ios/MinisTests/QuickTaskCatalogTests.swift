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

    func testLegacyDefinitionDecodesWithAutomaticOutputMode() throws {
        let json = #"{"id":"custom.old","name":"Old","prompt":"Summarize this","symbolName":"bolt.fill","isBuiltIn":false,"sortOrder":0}"#
        let decoded = try JSONDecoder().decode(QuickTaskDefinition.self, from: Data(json.utf8))

        XCTAssertEqual(decoded.outputMode, .automatic)
        XCTAssertTrue(decoded.inputSlotNames.isEmpty)
    }

    func testTemplateSlotsRenderAndStructuredRequirementIsAppended() {
        let task = QuickTaskDefinition(
            id: "custom.template",
            name: "Research",
            prompt: "Research {{topic}} for {{audience}}. Revisit {{topic}}.",
            symbolName: "magnifyingglass",
            isBuiltIn: false,
            sortOrder: 0,
            outputMode: .json
        )

        XCTAssertEqual(task.inputSlotNames, ["topic", "audience"])
        let rendered = task.renderedPrompt(inputValues: ["topic": "Swift", "audience": "iOS developers"])
        XCTAssertTrue(rendered.contains("Research Swift for iOS developers. Revisit Swift."))
        XCTAssertTrue(rendered.contains("valid JSON object"))
    }

    @MainActor
    func testExportAndImportCreatesIndependentCustomTemplate() throws {
        let suiteName = "QuickTaskCatalogExportTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = QuickTaskStore(defaults: defaults)
        let created = try XCTUnwrap(store.add(
            name: "Artifact Brief",
            prompt: "Create a report about {{topic}}",
            outputMode: .artifact
        ))
        let data = try XCTUnwrap(store.exportData(id: created.id))
        let imported = try XCTUnwrap(store.importData(data))

        XCTAssertNotEqual(imported.id, created.id)
        XCTAssertEqual(imported.outputMode, .artifact)
        XCTAssertEqual(imported.inputSlotNames, ["topic"])
        XCTAssertEqual(imported.sortOrder, store.tasks.count - 1)
        XCTAssertEqual(store.tasks.filter { $0.name == "Artifact Brief" }.count, 2)
    }

    @MainActor
    func testComposerPinsAreStableLimitedAndPruned() throws {
        let suiteName = "QuickTaskComposerPinsTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = QuickTaskStore(defaults: defaults)

        XCTAssertEqual(store.composerTaskIDs, ["analyzeSleep", "healthReport", "checkWeather"])
        XCTAssertFalse(store.setComposerPinned(true, id: "morningBriefing"))
        XCTAssertTrue(store.setComposerPinned(false, id: "healthReport"))
        XCTAssertTrue(store.setComposerPinned(true, id: "morningBriefing"))
        XCTAssertEqual(store.composerTaskIDs, ["analyzeSleep", "checkWeather", "morningBriefing"])

        let custom = try XCTUnwrap(store.add(name: "Temporary", prompt: "Do the task"))
        XCTAssertTrue(store.setComposerPinned(false, id: "analyzeSleep"))
        XCTAssertTrue(store.setComposerPinned(true, id: custom.id))
        store.delete(id: custom.id)
        XCTAssertFalse(store.composerTaskIDs.contains(custom.id))

        let reloaded = QuickTaskStore(defaults: defaults)
        XCTAssertEqual(reloaded.composerTaskIDs, ["checkWeather", "morningBriefing"])
    }
}
