import Foundation

private enum TemplateSmokeFailure: Error {
    case assertion(String)
}

@main
enum QuickTaskTemplateSmoke {
    @MainActor
    static func main() throws {
        let legacyJSON = #"{"id":"custom.old","name":"Old","prompt":"Summarize this","symbolName":"bolt.fill","isBuiltIn":false,"sortOrder":0}"#
        let legacy = try JSONDecoder().decode(QuickTaskDefinition.self, from: Data(legacyJSON.utf8))
        try expect(legacy.outputMode == .automatic, "legacy decode default")

        let template = QuickTaskDefinition(
            id: "custom.smoke",
            name: "Research",
            prompt: "Research {{topic}} for {{audience}} and revisit {{topic}}.",
            symbolName: "magnifyingglass",
            isBuiltIn: false,
            sortOrder: 0,
            outputMode: .json
        )
        try expect(template.inputSlotNames == ["topic", "audience"], "slot extraction")
        let rendered = template.renderedPrompt(inputValues: [
            "topic": "Swift",
            "audience": "iOS developers",
        ])
        try expect(rendered.contains("Research Swift for iOS developers and revisit Swift."), "slot rendering")
        try expect(rendered.contains("valid JSON object"), "structured output contract")

        let suiteName = "QuickTaskTemplateSmoke.\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suiteName) else {
            throw TemplateSmokeFailure.assertion("defaults suite")
        }
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = QuickTaskStore(defaults: defaults)
        guard let created = store.add(
            name: template.name,
            prompt: template.prompt,
            symbolName: template.symbolName,
            outputMode: template.outputMode
        ), let exported = store.exportData(id: created.id),
           let imported = store.importData(exported) else {
            throw TemplateSmokeFailure.assertion("export/import")
        }
        try expect(imported.id != created.id, "import identity isolation")
        try expect(imported.outputMode == .json, "output mode round-trip")
        try expect(imported.sortOrder == store.tasks.count - 1, "import remains at end of catalog")
        print("QuickTaskTemplateSmoke: template lifecycle passed")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw TemplateSmokeFailure.assertion(message) }
    }
}
