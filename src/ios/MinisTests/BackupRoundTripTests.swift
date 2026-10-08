import Foundation
import XCTest

/// End-to-end: the real exporter, zip writer/extractor, crypto, integrity
/// checks, importer and undo journal, against two fake devices.
final class BackupRoundTripTests: XCTestCase {

    private var worlds: [FakeBackupWorld] = []

    override func tearDown() {
        worlds.forEach { $0.destroy() }
        worlds = []
        super.tearDown()
    }

    private func world(_ name: String) throws -> FakeBackupWorld {
        let w = try FakeBackupWorld(name: name)
        worlds.append(w)
        return w
    }

    private let t0 = Date(timeIntervalSince1970: 1_780_000_000)
    private let secretKey = "sk-live-THIS-MUST-NOT-LEAK-123456"
    private let secretEnv = "ghp_envsecretvalue_987654"
    private let secretHeader = "Bearer mcp-header-secret-555"

    /// A device with something in every category.
    private func populated(_ name: String = "A") throws -> FakeBackupWorld {
        let w = try world(name)
        for (i, sid) in ["S1", "S2"].enumerated() {
            w.sessions[sid] = BackupSessionRecord(
                session: .init(id: sid, title: "会话 \(sid)", category: nil, modelId: "gpt",
                               createdAt: t0, updatedAt: t0.addingTimeInterval(Double(i) * 10)),
                memoryEnabled: true, modelBinding: nil)
            for n in 0..<3 {
                let id = "\(sid)-m\(n)"
                w.messages[id] = BackupMessageRecord(id: id, sessionId: sid, role: n % 2 == 0 ? "user" : "assistant",
                                                     parts: FakeBackupWorld.textParts("hello \(id)"),
                                                     createdAt: t0, sortOrder: n, updatedAt: t0)
            }
        }
        w.markers["mk1"] = BackupCompactMarkerRecord(id: "mk1", sessionId: "S1", summary: "sum",
                                                     firstKeptSortOrder: 1, compactedCount: 1, createdAt: t0)
        try w.write("attachment", to: "S1/attachments/uploads/a.txt", under: w.chatsRoot(), mtime: t0)
        try w.write("workspace", to: "S2/workspace/notes/n.md", under: w.chatsRoot(), mtime: t0)
        try w.write("shared doc", to: "docs/readme.txt", under: w.sharedFilesRoot(), mtime: t0)
        try w.write("---\nname: Demo\n---\nbody", to: "demo/SKILL.md", under: w.skillsRoot(), mtime: t0)
        try w.write("print(1)", to: "demo/scripts/run.py", under: w.skillsRoot(), mtime: t0)
        try w.write("junk", to: "demo/node_modules/x.js", under: w.skillsRoot(), mtime: t0)
        w.skillRecords["demo"] = BackupSkillRecord(id: "demo", name: "Demo", description: "", version: "1.0.0",
                                                   isEnabled: true, installedAt: t0, updatedAt: t0, body: "body", sourceURL: nil)
        try w.write("global memory", to: "GLOBAL.md", under: w.memoryRoot(), mtime: t0)
        try w.write("2026-10-01 log", to: "2026-10-01.md", under: w.memoryRoot(), mtime: t0)
        w.providerJSON = try JSONSerialization.data(withJSONObject: [
            "instances": [["id": "inst-1", "label": "OpenAI", "providerType": "openAI"]],
            "modelEntries": [["uuid": "e1", "providerInstanceId": "inst-1", "model": ["id": "gpt-5"]]],
            "modelGroups": [["id": "g1", "name": "Default", "memberEntryIds": ["inst-1/gpt-5"]]],
            "defaultPrimaryGroupId": "g1",
            "sessionBindings": [String: Any](),
        ])
        w.apiKeys["inst-1"] = secretKey
        w.rules = [BackupLeoThinkingRuleRecord(prefix: "gpt-5", maxLevel: "high", defaultLevel: "medium")]
        w.envEntries = [BackupEnvVarRecord(id: "ev1", key: "GITHUB_TOKEN", createdAt: t0, note: "gh")]
        w.envValues["GITHUB_TOKEN"] = secretEnv
        try JSONSerialization.data(withJSONObject: ["mcpServers": [
            "remote": ["url": "https://mcp.example.com/sse?key=abc", "headers": ["Authorization": secretHeader],
                       "updatedAt": t0.timeIntervalSince1970],
            "local": ["command": "npx", "args": ["server"], "env": ["HOME_DIR": "$HOME"],
                      "updatedAt": t0.timeIntervalSince1970],
        ]]).write(to: w.mcpServersFile())
        return w
    }

    private func export(_ w: FakeBackupWorld, passphrase: String? = nil,
                        categories: Set<BackupCategory> = Set(BackupCategory.backupable)) async throws -> BackupExporter.Summary {
        try await BackupExporter(source: w, workRoot: w.workRoot)
            .export(options: .init(categories: categories, passphrase: passphrase, snapshotAt: t0.addingTimeInterval(3600)))
    }

    private func importer(_ w: FakeBackupWorld) -> BackupImporter {
        BackupImporter(target: w, workRoot: w.workRoot, journalBase: w.journalBase)
    }

    private func restore(_ package: URL, into w: FakeBackupWorld, passphrase: String? = nil,
                         categories: Set<BackupCategory> = Set(BackupCategory.allCases)) async throws -> BackupImporter.Report {
        let imp = importer(w)
        let prepared = try await imp.open(packageURL: package, passphrase: passphrase)
        defer { imp.discard(prepared) }
        return try await imp.apply(prepared, categories: categories)
    }

    private func report(_ r: BackupImporter.Report, _ c: BackupCategory) -> BackupImporter.CategoryReport? {
        r.categories.first { $0.category == c }
    }

    // MARK: - Round trip

    func testUnencryptedRoundTripRestoresEverythingButSecrets() async throws {
        let a = try populated()
        let summary = try await export(a)
        XCTAssertFalse(summary.encrypted)
        XCTAssertFalse(summary.credentialsIncluded)
        XCTAssertEqual(a.collectSecretsCalls, 0, "no passphrase → the Keychain is never even read")
        XCTAssertTrue(summary.packageURL.lastPathComponent.hasSuffix(".minisbak"))
        XCTAssertFalse(summary.packageURL.lastPathComponent.contains("encrypted"))

        // No secret may appear anywhere in the bytes of an unencrypted package.
        let bytes = try Data(contentsOf: summary.packageURL)
        for secret in [secretKey, secretEnv, secretHeader, "key=abc"] {
            XCTAssertNil(bytes.range(of: Data(secret.utf8)), "plaintext secret leaked: \(secret)")
        }
        let names = try BackupPackageReader.listEntries(at: summary.packageURL).map(\.name)
        XCTAssertFalse(names.contains("secrets.json"))
        XCTAssertFalse(names.contains { $0.contains("node_modules") }, "excluded skill dirs stay out")

        let b = try world("B")
        let r = try await restore(summary.packageURL, into: b)
        XCTAssertFalse(r.hasFailures)
        XCTAssertEqual(Set(b.sessions.keys), ["S1", "S2"])
        XCTAssertEqual(b.messages.count, 6)
        XCTAssertEqual(b.messages["S1-m1"]?.parts, FakeBackupWorld.textParts("hello S1-m1"))
        XCTAssertEqual(b.markers.count, 1)
        XCTAssertEqual(b.read("S1/attachments/uploads/a.txt", under: b.chatsRoot()), "attachment")
        XCTAssertEqual(b.read("S2/workspace/notes/n.md", under: b.chatsRoot()), "workspace")
        XCTAssertEqual(b.read("docs/readme.txt", under: b.sharedFilesRoot()), "shared doc")
        XCTAssertEqual(b.read("demo/SKILL.md", under: b.skillsRoot()), "---\nname: Demo\n---\nbody")
        XCTAssertEqual(b.read("demo/scripts/run.py", under: b.skillsRoot()), "print(1)")
        XCTAssertEqual(b.read("GLOBAL.md", under: b.memoryRoot()), "global memory")
        XCTAssertEqual(b.rules.map(\.prefix), ["gpt-5"])
        XCTAssertEqual(Set(b.markedSessions), ["S1", "S2"], "restored sessions are re-marked for sync")

        let providers = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(b.providerJSON)) as? [String: Any])
        XCTAssertEqual((providers["instances"] as? [[String: Any]])?.first?["id"] as? String, "inst-1")
        XCTAssertTrue(b.apiKeys.isEmpty, "secrets are excluded without a passphrase")
        XCTAssertEqual(b.envEntries.map(\.key), ["GITHUB_TOKEN"])
        XCTAssertEqual(b.envValues["GITHUB_TOKEN"], "", "the variable comes back without its value")
        XCTAssertFalse(report(r, .environmentVariables)?.needsAttention.isEmpty ?? true)

        let mcp = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: b.mcpServersFile())) as? [String: Any])
        let servers = try XCTUnwrap(mcp["mcpServers"] as? [String: Any])
        let remote = try XCTUnwrap(servers["remote"] as? [String: Any])
        XCTAssertEqual((remote["headers"] as? [String: String])?["Authorization"], "")
        XCTAssertEqual(remote["url"] as? String, "https://mcp.example.com/sse")
        XCTAssertNil(remote[BackupMerge.redactionMarker], "bookkeeping marker never reaches the store")
        XCTAssertEqual(((servers["local"] as? [String: Any])?["env"] as? [String: String])?["HOME_DIR"], "$HOME",
                       "variable references are not secrets and survive")
    }

    func testEncryptedRoundTripCarriesSecretsAndHidesContent() async throws {
        let a = try populated()
        let summary = try await export(a, passphrase: "correct horse battery")
        XCTAssertTrue(summary.encrypted)
        XCTAssertTrue(summary.credentialsIncluded)
        XCTAssertTrue(summary.packageURL.lastPathComponent.contains("-encrypted"))

        let bytes = try Data(contentsOf: summary.packageURL)
        for plain in [secretKey, secretEnv, "hello S1-m1", "global memory", "shared doc"] {
            XCTAssertNil(bytes.range(of: Data(plain.utf8)), "plaintext visible in encrypted package: \(plain)")
        }
        // The manifest stays readable without the passphrase.
        let peek = try BackupPackageReader.peek(at: summary.packageURL)
        XCTAssertNotNil(peek.manifest.encryption)
        XCTAssertNotNil(peek.manifestMacSidecar)

        let b = try world("B")
        let r = try await restore(summary.packageURL, into: b, passphrase: "correct horse battery")
        XCTAssertFalse(r.hasFailures)
        XCTAssertTrue(r.wasEncrypted)
        XCTAssertEqual(b.apiKeys["inst-1"], secretKey)
        XCTAssertEqual(b.envValues["GITHUB_TOKEN"], secretEnv)
        XCTAssertEqual(b.messages.count, 6)
        XCTAssertEqual(b.read("demo/scripts/run.py", under: b.skillsRoot()), "print(1)")
        let servers = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(contentsOf: b.mcpServersFile())) as? [String: Any])?["mcpServers"] as? [String: Any])
        XCTAssertEqual(((servers["remote"] as? [String: Any])?["headers"] as? [String: String])?["Authorization"], secretHeader,
                       "an encrypted package keeps MCP secrets intact")
    }

    func testWrongOrMissingPassphraseIsRefusedBeforeUnpacking() async throws {
        let a = try populated()
        let summary = try await export(a, passphrase: "right-password")
        let b = try world("B")
        let imp = importer(b)
        do {
            _ = try await imp.open(packageURL: summary.packageURL, passphrase: "wrong-password")
            XCTFail("wrong passphrase must be refused")
        } catch let e as BackupCrypto.CryptoError {
            XCTAssertEqual(e, .wrongPassphrase)
        }
        do {
            _ = try await imp.open(packageURL: summary.packageURL, passphrase: nil)
            XCTFail("missing passphrase must be refused")
        } catch let e as BackupImporter.ImportError {
            XCTAssertEqual(e, .passphraseRequired)
        }
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: b.workRoot.path)
            .filter { $0.hasPrefix("restore-work-") }
        XCTAssertTrue(leftovers.isEmpty, "nothing is unpacked for a wrong passphrase")
        XCTAssertTrue(b.sessions.isEmpty)
    }

    // MARK: - Merge semantics

    func testMergeKeepsLocalNewerAndAddsTheRest() async throws {
        let a = try populated()
        let summary = try await export(a)

        let b = try world("B")
        // B edited S1 after the backup was taken.
        b.sessions["S1"] = BackupSessionRecord(
            session: .init(id: "S1", title: "本地改过", category: nil, modelId: "gpt",
                           createdAt: t0, updatedAt: t0.addingTimeInterval(7200)),
            memoryEnabled: false, modelBinding: nil)
        b.messages["S1-m0"] = BackupMessageRecord(id: "S1-m0", sessionId: "S1", role: "user",
                                                  parts: FakeBackupWorld.textParts("local edit"),
                                                  createdAt: t0, sortOrder: 0, updatedAt: t0.addingTimeInterval(7200))
        try b.write("local newer memory", to: "GLOBAL.md", under: b.memoryRoot(), mtime: t0.addingTimeInterval(7200))
        try b.write("local shared", to: "docs/readme.txt", under: b.sharedFilesRoot(), mtime: t0.addingTimeInterval(7200))
        b.envEntries = [BackupEnvVarRecord(id: "local", key: "GITHUB_TOKEN", createdAt: t0, note: "mine")]
        b.envValues["GITHUB_TOKEN"] = "local-value"
        b.providerJSON = try JSONSerialization.data(withJSONObject: [
            "instances": [["id": "inst-1", "label": "My renamed OpenAI", "providerType": "openAI"]],
            "modelEntries": [], "modelGroups": [], "sessionBindings": [String: Any](),
        ])
        b.apiKeys["inst-1"] = "local-key"

        let r = try await restore(summary.packageURL, into: b)
        XCTAssertFalse(r.hasFailures)
        XCTAssertEqual(b.sessions["S1"]?.session.title, "本地改过", "locally newer session kept")
        XCTAssertEqual(b.messages["S1-m0"]?.parts, FakeBackupWorld.textParts("local edit"))
        XCTAssertNil(b.messages["S1-m1"], "a kept session's backup messages are not merged in")
        XCTAssertNotNil(b.sessions["S2"], "missing session added")
        XCTAssertEqual(b.read("GLOBAL.md", under: b.memoryRoot()), "local newer memory")
        XCTAssertEqual(b.read("docs/readme.txt", under: b.sharedFilesRoot()), "local shared")
        XCTAssertEqual(b.envValues["GITHUB_TOKEN"], "local-value")
        XCTAssertEqual(b.envEntries.count, 1)
        XCTAssertEqual(b.apiKeys["inst-1"], "local-key")
        let providers = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(b.providerJSON)) as? [String: Any])
        XCTAssertEqual((providers["instances"] as? [[String: Any]])?.first?["label"] as? String, "My renamed OpenAI")
        XCTAssertGreaterThan(report(r, .chats)?.keptLocal ?? 0, 0)
        XCTAssertEqual(report(r, .memory)?.keptLocal, 1)
    }

    func testRestoringOwnBackupChangesNothing() async throws {
        let a = try populated()
        let summary = try await export(a)
        let r = try await restore(summary.packageURL, into: a)
        XCTAssertFalse(r.hasFailures)
        for c in r.categories {
            XCTAssertEqual(c.imported, 0, "\(c.category) imported something on its own device")
            XCTAssertEqual(c.updated, 0, "\(c.category) rewrote something on its own device")
        }
        XCTAssertTrue(a.markedSessions.isEmpty, "a no-op restore must not churn the sync queue")
    }

    func testRestoreRefusedWhileAffectedSessionRuns() async throws {
        let a = try populated()
        let summary = try await export(a)
        let b = try world("B")
        b.running = ["S2"]
        let imp = importer(b)
        let prepared = try await imp.open(packageURL: summary.packageURL, passphrase: nil)
        defer { imp.discard(prepared) }
        let plan = await imp.analyze(prepared)
        XCTAssertEqual(plan.runningSessions, 1)
        do {
            _ = try await imp.apply(prepared, categories: [.chats, .memory])
            XCTFail("must refuse")
        } catch let e as BackupImporter.ImportError {
            XCTAssertEqual(e, .sessionsRunning(1))
        }
        XCTAssertTrue(b.sessions.isEmpty)
        XCTAssertNil(b.read("GLOBAL.md", under: b.memoryRoot()), "refusal happens before ANY category")
    }

    // MARK: - Transactions / rollback

    func testFailedCategoryIsRolledBackAndOthersKept() async throws {
        let a = try populated()
        let summary = try await export(a)
        let b = try world("B")
        try b.write("pre-existing", to: "S1/keep.txt", under: b.chatsRoot())
        b.failChatsDB = true
        let r = try await restore(summary.packageURL, into: b, categories: [.chats, .sharedFiles])
        let chats = try XCTUnwrap(report(r, .chats))
        XCTAssertNotNil(chats.failed)
        XCTAssertTrue(chats.rolledBack)
        XCTAssertTrue(b.sessions.isEmpty)
        XCTAssertNil(b.read("S1/attachments/uploads/a.txt", under: b.chatsRoot()), "chat files written before the DB failure are undone")
        XCTAssertEqual(b.read("S1/keep.txt", under: b.chatsRoot()), "pre-existing", "rollback never touches unrelated files")
        XCTAssertFalse(FileManager.default.fileExists(atPath: b.chatsRoot().appendingPathComponent("S2").path),
                       "directories the restore created are removed again")
        XCTAssertNil(report(r, .sharedFiles)?.failed)
        XCTAssertEqual(b.read("docs/readme.txt", under: b.sharedFilesRoot()), "shared doc", "other categories still complete")
        let runs = (try? FileManager.default.contentsOfDirectory(atPath: BackupRestoreJournal.runsRoot(in: b.journalBase).path)) ?? []
        XCTAssertTrue(runs.isEmpty, "a finished run leaves no journal behind")
    }

    func testInterruptedRestoreIsUndoneAtLaunch() throws {
        let b = try world("B")
        try b.write("original", to: "GLOBAL.md", under: b.memoryRoot())
        let journal = try BackupRestoreJournal.begin(base: b.journalBase,
                                                     header: .init(backupId: "x", startedAt: Date(), categories: ["memory", "shared_files"]))
        // shared_files completed; memory was mid-flight when the app died.
        try journal.beginCategory(.sharedFiles)
        try journal.willCreate(.sharedFiles, root: .shared, path: "done.txt")
        try b.write("kept", to: "done.txt", under: b.sharedFilesRoot())
        try journal.endCategory(.sharedFiles)
        try journal.beginCategory(.memory)
        try journal.willReplace(.memory, root: .memory, path: "GLOBAL.md", live: b.memoryRoot().appendingPathComponent("GLOBAL.md"))
        try b.write("half-restored", to: "GLOBAL.md", under: b.memoryRoot())
        try journal.willCreate(.memory, root: .memory, path: "new.md")
        try b.write("new", to: "new.md", under: b.memoryRoot())
        journal.close()   // simulated crash: no finish()

        let reconciled = BackupRestoreJournal.reconcileAtLaunch(
            base: b.journalBase, roots: [.chats: b.chatsRoot(), .shared: b.sharedFilesRoot(), .memory: b.memoryRoot()])
        XCTAssertEqual(reconciled.first?.interruptedCategories, ["memory"])
        XCTAssertEqual(b.read("GLOBAL.md", under: b.memoryRoot()), "original")
        XCTAssertNil(b.read("new.md", under: b.memoryRoot()))
        XCTAssertEqual(b.read("done.txt", under: b.sharedFilesRoot()), "kept", "completed categories are not undone")
        XCTAssertTrue(BackupRestoreJournal.reconcileAtLaunch(base: b.journalBase, roots: [:]).isEmpty)
    }

    // MARK: - Hostile packages

    /// Rebuild a package from its members with `mutate` applied, keeping the
    /// original manifest (so the integrity map no longer matches).
    private func repack(_ url: URL, in w: FakeBackupWorld,
                        mutate: (URL) throws -> Void) throws -> URL {
        let dir = w.workRoot.appendingPathComponent("repack-\(UUID().uuidString)", isDirectory: true)
        try BackupZipExtractor.extract(url, to: dir)
        try mutate(dir)
        let out = w.workRoot.appendingPathComponent("repacked-\(UUID().uuidString).minisbak")
        let writer = try BackupZipWriter(url: out)
        let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.isRegularFileKey])!
        var files: [(URL, String)] = []
        for case let f as URL in e where (try? f.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true {
            files.append((f, BackupPaths.relativePath(of: f, under: dir)!))
        }
        for (f, rel) in files.sorted(by: { $0.1 < $1.1 }) { try writer.addFile(at: f, name: rel) }
        try writer.close()
        return out
    }

    func testTamperedMemberFailsIntegrityAndChangesNothing() async throws {
        let a = try populated()
        let summary = try await export(a)
        let bad = try repack(summary.packageURL, in: a) { dir in
            let f = dir.appendingPathComponent("data/sessions.jsonl")
            var d = try Data(contentsOf: f)
            d[d.count / 2] ^= 0x20
            try d.write(to: f)
        }
        let b = try world("B")
        do {
            _ = try await importer(b).open(packageURL: bad, passphrase: nil)
            XCTFail("tampered package must be refused")
        } catch let e as BackupImporter.ImportError {
            guard case .integrityFailed(let n) = e else { return XCTFail("\(e)") }
            XCTAssertEqual(n, 1)
        }
        XCTAssertTrue(b.sessions.isEmpty)
    }

    func testUnlistedMemberIsDiscardedNotImported() async throws {
        let a = try populated()
        let summary = try await export(a, categories: [.chats])
        let injected = try repack(summary.packageURL, in: a) { dir in
            let rec = BackupRecordEnvelope(t: "SessionV2", d: BackupSessionRecord(
                session: .init(id: "EVIL", title: "injected", category: nil, modelId: "x",
                               createdAt: Date(), updatedAt: Date()), memoryEnabled: true, modelBinding: nil))
            var line = try BackupDates.encoder().encode(rec); line.append(0x0A)
            try line.write(to: dir.appendingPathComponent("data/sessions-0002.jsonl"))
        }
        let b = try world("B")
        let imp = importer(b)
        let prepared = try await imp.open(packageURL: injected, passphrase: nil)
        defer { imp.discard(prepared) }
        XCTAssertEqual(prepared.ignoredMembers, 1)
        _ = try await imp.apply(prepared, categories: [.chats])
        XCTAssertNil(b.sessions["EVIL"], "a member the manifest doesn't vouch for is never read")
        XCTAssertEqual(Set(b.sessions.keys), ["S1", "S2"])
    }

    func testEncryptedManifestTamperingIsDetected() async throws {
        let a = try populated()
        let summary = try await export(a, passphrase: "pw-123456")
        let tampered = try repack(summary.packageURL, in: a) { dir in
            let f = dir.appendingPathComponent("manifest.json")
            var m = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: f)) as? [String: Any])
            m["device_name"] = "Someone else"
            try JSONSerialization.data(withJSONObject: m).write(to: f)
        }
        do {
            _ = try await importer(try world("B")).open(packageURL: tampered, passphrase: "pw-123456")
            XCTFail("tampered manifest must be refused")
        } catch let e as BackupCrypto.CryptoError {
            XCTAssertEqual(e, .manifestTampered)
        }
    }

    func testIndexedFileWhoseBlobIsMissingIsReportedNotFaked() async throws {
        let a = try world("A")
        try a.write("one", to: "a.txt", under: a.sharedFilesRoot(), mtime: t0)
        try a.write("two", to: "b.txt", under: a.sharedFilesRoot(), mtime: t0)
        let summary = try await export(a, categories: [.sharedFiles])
        let gone = BackupBlobStore.packagePath(for: BackupBlobStore.sha256(Data("two".utf8)))
        let damaged = try repack(summary.packageURL, in: a) { dir in
            try FileManager.default.removeItem(at: dir.appendingPathComponent(gone))
            let mURL = dir.appendingPathComponent("manifest.json")
            var m = try BackupDates.decoder().decode(BackupManifest.self, from: Data(contentsOf: mURL))
            m.integrity[gone] = nil
            try BackupDates.encoder().encode(m).write(to: mURL)
        }
        let b = try world("B")
        let r = try await restore(damaged, into: b, categories: [.sharedFiles])
        XCTAssertEqual(report(r, .sharedFiles)?.missingBlobs, 1)
        XCTAssertTrue(r.hasIssues)
        XCTAssertEqual(b.read("a.txt", under: b.sharedFilesRoot()), "one")
        XCTAssertNil(b.read("b.txt", under: b.sharedFilesRoot()), "never an empty stand-in")
    }

    func testPathTraversalInFileIndexIsRejected() async throws {
        let a = try world("A")
        a.sessions["S1"] = BackupSessionRecord(session: .init(id: "S1", title: nil, category: nil, modelId: "m",
                                                              createdAt: t0, updatedAt: t0), memoryEnabled: true, modelBinding: nil)
        try a.write("payload", to: "docs/x.txt", under: a.sharedFilesRoot(), mtime: t0)
        let summary = try await export(a, categories: [.sharedFiles])
        let sha = BackupBlobStore.sha256(Data("payload".utf8))
        // Hostile index lines pointing outside every root, with the integrity
        // map recomputed so they pass verification (an unencrypted package
        // carries no MAC — the containment checks must hold on their own).
        let evil = try repack(summary.packageURL, in: a) { dir in
            let index = dir.appendingPathComponent("files.index.jsonl")
            var lines = try Data(contentsOf: index)
            for path in ["shared/../../escape.txt", "shared/a/../../../escape2.txt", "shared//abs.txt",
                         "shared/\\..\\win.txt", "chats/../escape3.txt", "shared/./dot.txt"] {
                lines.append(try JSONEncoder().encode(BackupFileIndexEntry.file(path: path, size: 7, sha256: sha, category: .sharedFiles)))
                lines.append(0x0A)
            }
            try lines.write(to: index)
            let mURL = dir.appendingPathComponent("manifest.json")
            var m = try BackupDates.decoder().decode(BackupManifest.self, from: Data(contentsOf: mURL))
            m.integrity["files.index.jsonl"] = try BackupBlobStore.sha256OfFile(at: index)
            try BackupDates.encoder().encode(m).write(to: mURL)
        }
        let b = try world("B")
        let r = try await restore(evil, into: b, categories: [.sharedFiles])
        let shared = try XCTUnwrap(report(r, .sharedFiles))
        XCTAssertEqual(shared.rejectedPaths, 6)
        XCTAssertEqual(shared.filesWritten, 1, "the one legitimate file still restores")
        for name in ["escape.txt", "escape2.txt", "escape3.txt", "win.txt"] {
            XCTAssertFalse(FileManager.default.fileExists(atPath: b.root.appendingPathComponent(name).path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: b.root.deletingLastPathComponent().appendingPathComponent(name).path))
        }
    }

    func testSymlinkedDirectoryCannotRedirectARestore() async throws {
        let a = try world("A")
        try a.write("payload", to: "link/inner.txt", under: a.sharedFilesRoot(), mtime: t0)
        let summary = try await export(a, categories: [.sharedFiles])
        let b = try world("B")
        let outside = b.root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: b.sharedFilesRoot().appendingPathComponent("link"),
                                                   withDestinationURL: outside)
        let r = try await restore(summary.packageURL, into: b, categories: [.sharedFiles])
        XCTAssertEqual(report(r, .sharedFiles)?.rejectedPaths, 2, "the directory entry and the file under it")
        XCTAssertEqual(report(r, .sharedFiles)?.filesWritten, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("inner.txt").path))
    }

    func testZipEntryNamesThatEscapeAreRefused() throws {
        let b = try world("B")
        for name in ["../evil.txt", "/etc/evil", "a/../../evil", "a\\..\\evil", "a/./b", "a//b", "evil\u{0}.txt"] {
            let zip = b.workRoot.appendingPathComponent("t-\(UUID().uuidString).zip")
            try BackupTestZip.raw([(name: "manifest.json", method: 0, data: Data("{}".utf8), declaredSize: nil),
                                   (name: name, method: 0, data: Data("x".utf8), declaredSize: nil)]).write(to: zip)
            let out = b.workRoot.appendingPathComponent("out-\(UUID().uuidString)")
            XCTAssertThrowsError(try BackupZipExtractor.extract(zip, to: out), "accepted hostile name \(name)") { e in
                XCTAssertEqual(e as? BackupZipExtractor.ExtractError, .unsafePath(name))
            }
            XCTAssertThrowsError(try BackupPackageReader.peek(at: zip))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: b.root.appendingPathComponent("evil.txt").path))
    }

    func testZipBombsAndInconsistentEntriesAreRefused() throws {
        let b = try world("B")
        func zip(_ entries: [(name: String, method: UInt16, data: Data, declaredSize: UInt32?)]) throws -> URL {
            let url = b.workRoot.appendingPathComponent("bomb-\(UUID().uuidString).zip")
            try BackupTestZip.raw(entries).write(to: url)
            return url
        }
        // A deflated member claiming 4 GB.
        let bomb = try zip([(name: "data/x.jsonl", method: 8, data: Data(repeating: 0, count: 16), declaredSize: 0xFFFF_FFF0)])
        XCTAssertThrowsError(try BackupZipExtractor.extract(bomb, to: b.workRoot.appendingPathComponent("o1"))) {
            guard case .tooLarge = $0 as? BackupZipExtractor.ExtractError else { return XCTFail("\($0)") }
        }
        // STORED but declaring a different uncompressed size.
        let liar = try zip([(name: "a.bin", method: 0, data: Data(count: 10), declaredSize: 5_000_000)])
        XCTAssertThrowsError(try BackupZipExtractor.extract(liar, to: b.workRoot.appendingPathComponent("o2"))) {
            XCTAssertEqual($0 as? BackupZipExtractor.ExtractError, .inconsistentEntry("a.bin"))
        }
        // Total size cap and entry-count cap.
        let many = try zip((0..<20).map { (name: "f\($0)", method: UInt16(0), data: Data(count: 100), declaredSize: nil) })
        var limits = BackupZipExtractor.Limits.standard
        limits.maxEntries = 10
        XCTAssertThrowsError(try BackupZipExtractor.extract(many, to: b.workRoot.appendingPathComponent("o3"), limits: limits)) {
            XCTAssertEqual($0 as? BackupZipExtractor.ExtractError, .tooManyEntries(20))
        }
        limits = .standard
        limits.maxTotalBytes = 1_000
        XCTAssertThrowsError(try BackupZipExtractor.extract(many, to: b.workRoot.appendingPathComponent("o4"), limits: limits)) {
            XCTAssertEqual($0 as? BackupZipExtractor.ExtractError, .tooLarge(2_000))
        }
        limits = .standard
        limits.availableBytes = 500
        XCTAssertThrowsError(try BackupZipExtractor.extract(many, to: b.workRoot.appendingPathComponent("o5"), limits: limits)) {
            XCTAssertEqual($0 as? BackupZipExtractor.ExtractError, .insufficientSpace(needed: 2_000, available: 500))
        }
        // Duplicate names.
        let dup = try zip([(name: "a", method: 0, data: Data("1".utf8), declaredSize: nil),
                           (name: "a", method: 0, data: Data("2".utf8), declaredSize: nil)])
        XCTAssertThrowsError(try BackupZipExtractor.extract(dup, to: b.workRoot.appendingPathComponent("o6"))) {
            XCTAssertEqual($0 as? BackupZipExtractor.ExtractError, .duplicateEntry("a"))
        }
        // Truncated (the commonest real damage): the end records are gone.
        let full = BackupTestZip.raw([(name: "a", method: 0, data: Data(count: 50), declaredSize: nil)])
        let truncated = b.workRoot.appendingPathComponent("trunc.zip")
        try full.prefix(full.count / 2).write(to: truncated)
        XCTAssertThrowsError(try BackupZipExtractor.extract(truncated, to: b.workRoot.appendingPathComponent("o7"))) {
            XCTAssertEqual($0 as? BackupZipExtractor.ExtractError, .notAZip)
        }
    }

    func testPlaintextSecretsInUnencryptedPackageAreIgnored() async throws {
        let a = try populated()
        let summary = try await export(a, categories: [.providers])
        let withSecrets = try repack(summary.packageURL, in: a) { dir in
            let s = BackupSecrets(providers: [.init(instanceId: "inst-1", label: nil, providerType: "openAI",
                                                    apiKey: BackupSecrets.encode("sk-plaintext"))])
            let f = dir.appendingPathComponent("secrets.json")
            try JSONEncoder().encode(s).write(to: f)
            let mURL = dir.appendingPathComponent("manifest.json")
            var m = try BackupDates.decoder().decode(BackupManifest.self, from: Data(contentsOf: mURL))
            m.integrity["secrets.json"] = try BackupBlobStore.sha256OfFile(at: f)
            try BackupDates.encoder().encode(m).write(to: mURL)
        }
        let b = try world("B")
        let imp = importer(b)
        let prepared = try await imp.open(packageURL: withSecrets, passphrase: nil)
        defer { imp.discard(prepared) }
        XCTAssertTrue(prepared.ignoredPlaintextSecrets)
        XCTAssertFalse(prepared.hasSecrets)
        let r = try await imp.apply(prepared, categories: [.providers])
        XCTAssertTrue(b.apiKeys.isEmpty, "credentials are only accepted from an encrypted package")
        XCTAssertFalse(r.warnings.isEmpty)
    }

    func testCancelledExportLeavesNoPackage() async throws {
        let a = try populated()
        let exporter = BackupExporter(source: a, workRoot: a.workRoot)
        let snapshot = t0.addingTimeInterval(3600)
        let task = Task { try await exporter.export(options: .init(snapshotAt: snapshot)) }
        task.cancel()
        _ = try? await task.value
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: a.workRoot.path)
            .filter { $0.hasSuffix(".partial") || $0.hasPrefix("minisbak-") }
        XCTAssertTrue(leftovers.isEmpty, "cancel/failure removes partial package and staging: \(leftovers)")
        XCTAssertNil(BackupExportJournal.interrupted(in: a.workRoot))
    }

    func testExportAndRestoreAreMutuallyExclusive() async throws {
        let lock = BackupActivityLock.shared
        let outer: Void = try await lock.withLock(.export) {
            do {
                _ = try await lock.withLock(.restore) { 1 }
                XCTFail("second activity must be refused")
            } catch let busy as BackupActivityLock.Busy {
                XCTAssertEqual(busy.current, .export)
            }
        }
        _ = outer
        let free = await lock.isBusy
        XCTAssertFalse(free)
    }
}
