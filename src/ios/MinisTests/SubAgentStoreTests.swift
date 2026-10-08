import XCTest

/// [T-subagent] P3 roles store: the settings screen edits through these calls,
/// so the limits and protections the UI shows are enforced here, on disk.
@MainActor
final class SubAgentStoreTests: XCTestCase {
    private var url: URL!

    override func setUp() async throws {
        url = FileManager.default.temporaryDirectory.appendingPathComponent("sub-agents-\(UUID().uuidString).json")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: url)
    }

    func testFreshStoreHasOnlyTheBuiltIn() {
        let store = SubAgentStore(fileURL: url)
        XCTAssertEqual(store.subAgents.map(\.id), [SubAgentDefinition.builtInId])
        XCTAssertTrue(store.canAddSubAgent)
    }

    func testCustomRolePersistsAcrossReload() {
        let store = SubAgentStore(fileURL: url)
        XCTAssertTrue(store.upsertSubAgent(SubAgentDefinition(name: "研究员", description: "多轮检索",
                                                              instructions: "列出来源", modelGroupId: "g1",
                                                              thinkingLevelOverride: .high)))
        let reloaded = SubAgentStore(fileURL: url)
        let role = reloaded.subAgents.first { $0.name == "研究员" }
        XCTAssertEqual(role?.instructions, "列出来源")
        XCTAssertEqual(role?.modelGroupId, "g1")
        XCTAssertEqual(role?.thinkingLevelOverride, .high)
        XCTAssertEqual(reloaded.subAgents.first?.id, SubAgentDefinition.builtInId)
    }

    func testDuplicateOrEmptyNamesAreRefused() {
        let store = SubAgentStore(fileURL: url)
        XCTAssertTrue(store.upsertSubAgent(SubAgentDefinition(name: "Reviewer", description: "d")))
        XCTAssertFalse(store.upsertSubAgent(SubAgentDefinition(name: " reviewer ", description: "d")),
                       "names the model could not tell apart are refused")
        XCTAssertFalse(store.upsertSubAgent(SubAgentDefinition(name: "   ", description: "d")))
        XCTAssertTrue(store.subAgentNameIsTaken("REVIEWER", excluding: nil))
        XCTAssertEqual(store.subAgents.count, 2)
    }

    func testRosterIsCappedAtTenIncludingTheBuiltIn() {
        let store = SubAgentStore(fileURL: url)
        for i in 1...12 { store.upsertSubAgent(SubAgentDefinition(name: "Role \(i)", description: "d")) }
        XCTAssertEqual(store.subAgents.count, SubAgentLimits.maxCount)
        XCTAssertFalse(store.canAddSubAgent)
    }

    func testBuiltInKeepsItsIdentityAndCannotBeDeleted() {
        let store = SubAgentStore(fileURL: url)
        var builtIn = store.subAgents[0]
        builtIn.name = "Hacked"
        builtIn.description = "changed"
        builtIn.instructions = "Always cite sources."
        XCTAssertTrue(store.upsertSubAgent(builtIn))
        XCTAssertEqual(store.subAgents[0].name, SubAgentDefinition.builtInName, "the name the model emits is canonical")
        XCTAssertEqual(store.subAgents[0].description, SubAgentDefinition.builtInDescription)
        XCTAssertEqual(store.subAgents[0].instructions, "Always cite sources.", "the user's own fields are kept")
        store.removeSubAgent(id: SubAgentDefinition.builtInId)
        XCTAssertEqual(store.subAgents.first?.id, SubAgentDefinition.builtInId)
    }

    func testReorderAndDeleteAndClearedGroup() {
        let store = SubAgentStore(fileURL: url)
        store.upsertSubAgent(SubAgentDefinition(id: "a", name: "A", description: "d", modelGroupId: "g"))
        store.upsertSubAgent(SubAgentDefinition(id: "b", name: "B", description: "d"))
        store.reorderSubAgents(["b", "a"])
        XCTAssertEqual(store.subAgents.map(\.id), [SubAgentDefinition.builtInId, "b", "a"])
        store.clearModelGroup("g")
        XCTAssertNil(store.subAgent(id: "a")?.modelGroupId, "a deleted group reverts the role to Auto")
        store.removeSubAgent(id: "b")
        XCTAssertEqual(store.subAgents.map(\.id), [SubAgentDefinition.builtInId, "a"])
    }

    func testCorruptFileFallsBackToTheBuiltIn() throws {
        try Data("not json".utf8).write(to: url)
        let store = SubAgentStore(fileURL: url)
        XCTAssertEqual(store.subAgents.map(\.id), [SubAgentDefinition.builtInId])
    }
}
