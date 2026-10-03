import XCTest
@testable import NativeModelAudit

final class AuditCodecTests: XCTestCase {
    func testProductionModelIdentityOverridesAndGroupOrderingRoundTrip() throws {
        let provider = ProviderInstance(id: "synthetic-provider", label: "My Custom Provider", providerType: .openAI,
                                        credentialType: .apiKey, customBaseURL: "https://fixture.invalid/v1")
        let entry = ModelEntry(uuid: "legacy-uuid", providerInstanceId: provider.id,
                               model: LLMModel(id: "vendor/model:version", displayName: "API Model", provider: "Fixture"),
                               overrides: ModelOverrides(displayName: "My Model", contextWindow: 42_000), isCustom: true, isHidden: true)
        let group = ModelGroup(id: "user-group", name: "My Routing Group", memberEntryIds: [entry.id, "temporarily-missing/model"],
                               strategy: .fallback, fallbackStrategy: .always, defaultThinkingLevel: .high)
        let restoredEntry = try JSONDecoder().decode(ModelEntry.self, from: JSONEncoder().encode(entry))
        let restoredGroup = try JSONDecoder().decode(ModelGroup.self, from: JSONEncoder().encode(group))
        let restoredProvider = try JSONDecoder().decode(ProviderInstance.self, from: JSONEncoder().encode(provider))
        XCTAssertEqual(restoredEntry, entry)
        XCTAssertEqual(restoredEntry.id, "synthetic-provider/vendor/model:version")
        XCTAssertEqual(restoredEntry.model.displayName, "My Model")
        XCTAssertEqual(restoredGroup, group)
        XCTAssertEqual(restoredGroup.memberEntryIds, [entry.id, "temporarily-missing/model"])
        XCTAssertEqual(restoredProvider, provider)
        XCTAssertEqual(restoredProvider.label, "My Custom Provider")
    }

    func testProductionBindingRoundTripPreservesGroupAndDirectIdentity() throws {
        let bindings = [
            SessionModelBinding(sessionId: "a", primarySource: .directEntry(modelEntryId: "legacy-uuid", compositeKey: "provider/vendor/model:version")),
            SessionModelBinding(sessionId: "b", primarySource: .group(groupId: "routing-group", resolvedEntryId: "provider/model")),
        ]
        let restored = try JSONDecoder().decode([SessionModelBinding].self, from: JSONEncoder().encode(bindings))
        XCTAssertEqual(restored, bindings)
        XCTAssertEqual(restored[0].primarySource.preferredReference, "provider/vendor/model:version")
        XCTAssertEqual(restored[1].primarySource.preferredReference, "provider/model")
    }
}
