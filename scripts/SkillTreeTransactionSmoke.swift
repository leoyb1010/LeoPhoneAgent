import Foundation
#if os(Linux)
import Glibc
#else
import Darwin
#endif

@MainActor @main enum SkillTreeTransactionSmoke {
    static let fm = FileManager.default
    static func check(_ value: Bool) { precondition(value) }
    static func expectFailure(_ body: () throws -> Void) {
        do { try body(); preconditionFailure("expected injected failure") } catch {}
    }
    static func setup(_ home: URL, topology: String) throws -> SkillStore {
        let store = try SkillStore(home)
        let oldPath = topology == "to-file" ? "foo/bar.txt" : "foo"
        for root in [store.skillsDir, store.rootfsSkillsDir] {
            let old = root.appendingPathComponent("skill/" + oldPath)
            try fm.createDirectory(at: old.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("old bytes".utf8).write(to: old)
            try Data("old markdown".utf8).write(to: root.appendingPathComponent("skill/SKILL.md"))
            try Data("private bytes".utf8).write(to: root.appendingPathComponent("skill/.local"))
            let neighbor = root.appendingPathComponent("other/keep")
            try fm.createDirectory(at: neighbor.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("neighbor".utf8).write(to: neighbor)
        }
        store.seed()
        store.seedGuest(oldPath)
        return store
    }
    static func assertTree(_ store: SkillStore, topology: String, committed: Bool) throws {
        let oldPath = topology == "to-file" ? "foo/bar.txt" : "foo"
        let newPath = topology == "to-dir" ? "foo/bar.txt" : "foo"
        for root in [store.skillsDir, store.rootfsSkillsDir] {
            let directory = root.appendingPathComponent("skill")
            let actual = try Data(contentsOf: directory.appendingPathComponent(committed ? newPath : oldPath))
            precondition(actual == Data((committed ? "new bytes" : "old bytes").utf8))
            check(try Data(contentsOf: directory.appendingPathComponent("SKILL.md")) == Data((committed ? "new markdown" : "old markdown").utf8))
            check(try Data(contentsOf: directory.appendingPathComponent(".local")) == Data("private bytes".utf8))
            check(try Data(contentsOf: root.appendingPathComponent("other/keep")) == Data("neighbor".utf8))
        }
        precondition(store.timestamp() == (committed ? 10 : 1))
    }
    static func assertGuest(_ store: SkillStore, topology: String) {
        precondition(store.guestType("foo") == (topology == "to-dir" ? 0o040000 : 0o100000))
        precondition(store.guestType("foo/bar.txt") == (topology == "to-dir" ? 0o100000 : nil))
    }
    static func main() throws {
        let arguments = CommandLine.arguments
        let mode = arguments[1], home = URL(fileURLWithPath: arguments[2])
        if mode == "crash" {
            let topology = arguments[4], stage = arguments[5]
            let store = try setup(home, topology: topology)
            let zip = try Data(contentsOf: URL(fileURLWithPath: arguments[3]))
            try store.applyDirect(zip) { checkpoint in if checkpoint == stage { exit(73) } }
            preconditionFailure("crash checkpoint not reached")
        }
        if mode == "delete" {
            let store = try SkillStore(home)
            store.deleteSkill("skill")
            precondition(store.timestamp() == -1)
            precondition(!fm.fileExists(atPath: store.skillsDir.appendingPathComponent("skill").path))
            precondition(!fm.fileExists(atPath: store.rootfsSkillsDir.appendingPathComponent("skill").path))
            try store.recover()
            try store.recover()
            return
        }
        if mode == "reject-delete" {
            let store = try SkillStore(home)
            store.deleteSkill("skill")
            try assertTree(store, topology: "to-dir", committed: false)
            return
        }
        if mode == "reject-recover" {
            let store = try SkillStore(home)
            expectFailure { try store.recover() }
            try assertTree(store, topology: "to-dir", committed: false)
            return
        }
        if mode == "recover" {
            let topology = arguments[4], stage = arguments[5]
            let store = try SkillStore(home)
            try store.recover()
            try store.recover() // Recovery is idempotent, including consumed backups.
            try assertTree(store, topology: topology, committed: stage == "committed")
            let zip = try Data(contentsOf: URL(fileURLWithPath: arguments[3]))
            try store.applyDomain(zip)
            try assertTree(store, topology: topology, committed: true)
            assertGuest(store, topology: topology)
            return
        }
        // Exact ROUND1 trigger: valid ZIP changes foo to foo/bar.txt, then
        // reverse topology; exercise the production import twice, plus control.
        for topology in ["to-dir", "to-file", "control"] {
            let zip = try Data(contentsOf: home.appendingPathComponent(topology + ".zip"))
            let store = try setup(home.appendingPathComponent("ordinary-" + topology), topology: topology)
            for _ in 0..<2 {
                try store.applyDomain(zip)
                try assertTree(store, topology: topology, committed: true)
                assertGuest(store, topology: topology)
            }
            let checkpoints = ["staged-0", "staged-1", "prepared", "backed-up-0", "installed-0", "backed-up-1", "installed-1"]
            for checkpoint in checkpoints {
                let failing = try setup(home.appendingPathComponent("failure-" + topology + checkpoint), topology: topology)
                expectFailure { try failing.applyDirect(zip) { if $0 == checkpoint { throw CocoaError(.fileWriteOutOfSpace) } } }
                try assertTree(failing, topology: topology, committed: false)
                try failing.recover()
                try failing.applyDomain(zip)
                try assertTree(failing, topology: topology, committed: true)
                assertGuest(failing, topology: topology)
            }
            // A late token insertion failure must roll back the earlier metadata
            // upsert, then restore both original trees and allow the same retry.
            let failingDB = try setup(home.appendingPathComponent("db-failure-" + topology), topology: topology)
            failingDB.sql("CREATE TRIGGER deny_marker BEFORE INSERT ON skill_sync_commits BEGIN SELECT RAISE(ABORT,'marker failure'); END")
            expectFailure { try failingDB.applyDomain(zip) }
            try assertTree(failingDB, topology: topology, committed: false)
            failingDB.sql("DROP TRIGGER deny_marker")
            try failingDB.applyDomain(zip)
            try assertTree(failingDB, topology: topology, committed: true)
            assertGuest(failingDB, topology: topology)
        }
        // Force Foundation's actual second-root move to fail after both old
        // roots were backed up. The injected callback itself does not throw.
        let moveFailure = try setup(home.appendingPathComponent("actual-move-failure"), topology: "to-dir")
        let transitionZip = try Data(contentsOf: home.appendingPathComponent("to-dir.zip"))
        expectFailure {
            try moveFailure.applyDirect(transitionZip) { checkpoint in
                if checkpoint == "backed-up-1" {
                    try Data("blocking destination".utf8).write(to: moveFailure.rootfsSkillsDir.appendingPathComponent("skill"))
                }
            }
        }
        try assertTree(moveFailure, topology: "to-dir", committed: false)
        try moveFailure.applyDomain(transitionZip)
        try assertTree(moveFailure, topology: "to-dir", committed: true)
        assertGuest(moveFailure, topology: "to-dir")
        // New installs have no backup to restore. A failed second swap removes
        // the newly installed first tree and retries from the same ZIP.
        let fresh = try SkillStore(home.appendingPathComponent("fresh-install"))
        expectFailure { try fresh.applyDirect(transitionZip) { if $0 == "installed-1" { throw CocoaError(.fileWriteOutOfSpace) } } }
        precondition(!fm.fileExists(atPath: fresh.skillsDir.appendingPathComponent("skill").path))
        precondition(!fm.fileExists(atPath: fresh.rootfsSkillsDir.appendingPathComponent("skill").path))
        precondition(fresh.timestamp() == -1)
        try fresh.applyDomain(transitionZip)
        for root in [fresh.skillsDir, fresh.rootfsSkillsDir] {
            check(try Data(contentsOf: root.appendingPathComponent("skill/foo/bar.txt")) == Data("new bytes".utf8))
        }
        let preserved = try setup(home.appendingPathComponent("no-zip"), topology: "to-dir")
        try preserved.applyDomain(nil)
        for root in [preserved.skillsDir, preserved.rootfsSkillsDir] {
            check(try Data(contentsOf: root.appendingPathComponent("skill/foo")) == Data("old bytes".utf8))
        }
        // Symlinked second root destination rejects before touching first root.
        let symlinkStore = try setup(home.appendingPathComponent("symlink"), topology: "to-dir")
        let second = symlinkStore.rootfsSkillsDir.appendingPathComponent("skill")
        let original = symlinkStore.rootfsSkillsDir.appendingPathComponent("backup")
        try fm.moveItem(at: second, to: original)
        try fm.createSymbolicLink(at: second, withDestinationURL: original)
        let zip = try Data(contentsOf: home.appendingPathComponent("to-dir.zip"))
        expectFailure { try symlinkStore.applyDomain(zip) }
        check(try Data(contentsOf: symlinkStore.skillsDir.appendingPathComponent("skill/foo")) == Data("old bytes".utf8))
        check(try Data(contentsOf: original.appendingPathComponent("foo")) == Data("old bytes".utf8))
        print("Skill exact import topology, second-root failure, SQL/fakefs metadata, hidden-data and symlink controls PASS")
    }
}
