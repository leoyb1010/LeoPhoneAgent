import Foundation

/// Installs a validated skill tree at both filesystem roots. Backups remain
/// recoverable until the caller atomically commits metadata and the token in
/// SQLite. On restart that token distinguishes rollback from committed cleanup.
/// All paths in the journal are relative; an iOS container move is harmless.
struct SkillSyncTreeTransaction {
    let roots: [URL]
    private let fm = FileManager.default
    private struct Manifest: Codable {
        let token: String
        let skillID: String
        let hadOriginal: [Bool]
    }

    // Fault injection is an explicit dependency used by filesystem regression
    // tests. Production uses the default no-op; it is never persisted.
    var checkpoint: (String) throws -> Void = { _ in }

    private func container(_ root: URL) throws -> URL {
        try SyncFileSafety.destination(root: root.deletingLastPathComponent(),
                                       relativePath: ".\(root.lastPathComponent)-sync-transactions")
    }
    private func directory(_ root: URL, token: String) throws -> URL {
        guard UUID(uuidString: token) != nil else { throw CocoaError(.fileReadCorruptFile) }
        return try SyncFileSafety.destination(root: container(root), relativePath: token)
    }
    private func node(_ root: URL, token: String, name: String) throws -> URL {
        try SyncFileSafety.destination(root: directory(root, token: token), relativePath: name)
    }
    private func exists(_ url: URL) throws -> Bool {
        do {
            let attrs = try fm.attributesOfItem(atPath: url.path)
            guard attrs[.type] as? FileAttributeType != .typeSymbolicLink else {
                throw CocoaError(.fileReadInvalidFileName)
            }
            return true
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile { return false }
    }

    /// Run before exposing skills on startup and before another inbound apply.
    func recover(isCommitted: (String, String) throws -> Bool) throws {
        guard let first = roots.first else { throw CocoaError(.fileWriteUnknown) }
        let home = try container(first)
        guard try exists(home) else { return }
        for child in try fm.contentsOfDirectory(at: home, includingPropertiesForKeys: nil) {
            guard UUID(uuidString: child.lastPathComponent) != nil else { continue }
            let manifestURL = try node(first, token: child.lastPathComponent, name: "manifest.json")
            // Without the manifest no live rename was permitted. Discard only
            // these UUID-scoped staging copies, including the second root.
            guard try exists(manifestURL) else {
                for root in roots.reversed() {
                    let work = try directory(root, token: child.lastPathComponent)
                    if try exists(work) { try fm.removeItem(at: work) }
                }
                continue
            }
            let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: manifestURL))
            guard manifest.token == child.lastPathComponent, manifest.hadOriginal.count == roots.count else {
                throw CocoaError(.fileReadCorruptFile)
            }
            _ = try SyncFileSafety.component(manifest.skillID)
            try finish(manifest, committed: isCommitted(manifest.skillID, manifest.token))
        }
    }

    /// `entries == nil` preserves the existing bundle, replacing only SKILL.md.
    /// With a ZIP, nonhidden bundle files are replaced; hidden local data keeps
    /// its previous semantics. A hidden-file topology conflict fails safely.
    func apply(skillID: String, content: String, entries: [SafeSkillArchive.Entry]?, updatedAt: Date,
               isCommitted: (String, String) throws -> Bool,
               commitMetadata: (String) throws -> Void) throws {
        _ = try SyncFileSafety.component(skillID)
        guard !roots.isEmpty, Set(roots.map { $0.standardizedFileURL.path }).count == roots.count else {
            throw CocoaError(.fileWriteUnknown)
        }
        try recover(isCommitted: isCommitted)
        let destinations = try roots.map { try SyncFileSafety.destination(root: $0, relativePath: skillID) }
        // Check live destinations before staging. This rejects unsafe existing
        // symlink ancestors without treating a regular-file ancestor as a path.
        for root in roots {
            _ = try SyncFileSafety.destination(root: root, relativePath: "\(skillID)/SKILL.md")
            for entry in entries ?? [] {
                let path = entry.isDirectory ? String(entry.name.dropLast()) : entry.name
                _ = try SyncFileSafety.destination(root: root, relativePath: "\(skillID)/\(path)")
            }
        }
        let token = UUID().uuidString
        let manifest = try Manifest(token: token, skillID: skillID, hadOriginal: destinations.map { try exists($0) })
        var journaled = false
        do {
            for (index, root) in roots.enumerated() {
                let work = try directory(root, token: token)
                try fm.createDirectory(at: work, withIntermediateDirectories: true)
                let staged = try node(root, token: token, name: "new")
                if manifest.hadOriginal[index] {
                    let attrs = try fm.attributesOfItem(atPath: destinations[index].path)
                    guard attrs[.type] as? FileAttributeType == .typeDirectory else { throw CocoaError(.fileReadInvalidFileName) }
                    try fm.copyItem(at: destinations[index], to: staged)
                } else {
                    try fm.createDirectory(at: staged, withIntermediateDirectories: true)
                }
                if let entries {
                    try pruneManagedFiles(in: staged)
                    for entry in entries where entry.name != "SKILL.md" && !entry.name.hasPrefix(".") {
                        let path = entry.isDirectory ? String(entry.name.dropLast()) : entry.name
                        let target = try SyncFileSafety.destination(root: staged, relativePath: path)
                        if entry.isDirectory {
                            try fm.createDirectory(at: target, withIntermediateDirectories: true)
                        } else {
                            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                            try entry.data.write(to: target, options: .atomic)
                            try fm.setAttributes([.modificationDate: updatedAt], ofItemAtPath: target.path)
                        }
                    }
                }
                let markdown = try SyncFileSafety.destination(root: staged, relativePath: "SKILL.md")
                try content.write(to: markdown, atomically: true, encoding: .utf8)
                try fm.setAttributes([.modificationDate: updatedAt], ofItemAtPath: markdown.path)
                try checkpoint("staged-\(index)")
            }
            let manifestURL = try node(roots[0], token: token, name: "manifest.json")
            try JSONEncoder().encode(manifest).write(to: manifestURL, options: .atomic)
            journaled = true
            try checkpoint("prepared")
            for (index, root) in roots.enumerated() {
                try fm.createDirectory(at: root, withIntermediateDirectories: true)
                if manifest.hadOriginal[index] {
                    try fm.moveItem(at: destinations[index], to: node(root, token: token, name: "old"))
                }
                try checkpoint("backed-up-\(index)")
                try fm.moveItem(at: node(root, token: token, name: "new"), to: destinations[index])
                try checkpoint("installed-\(index)")
            }
            try commitMetadata(token)
            try checkpoint("committed")
            try finish(manifest, committed: true)
        } catch {
            if journaled {
                // If cleanup itself fails, leave the manifest and backups for
                // startup/replay. Never report success for an uncertain apply.
                try finish(manifest, committed: isCommitted(skillID, token))
            } else {
                for root in roots {
                    let work = try directory(root, token: token)
                    if try exists(work) { try fm.removeItem(at: work) }
                }
            }
            throw error
        }
    }

    private func finish(_ manifest: Manifest, committed: Bool) throws {
        for (index, root) in roots.enumerated() {
            let destination = try SyncFileSafety.destination(root: root, relativePath: manifest.skillID)
            let backup = try node(root, token: manifest.token, name: "old")
            let staged = try node(root, token: manifest.token, name: "new")
            if committed {
                guard try exists(destination) else { throw CocoaError(.fileReadCorruptFile) }
            } else if try exists(backup) {
                if try exists(destination) { try fm.removeItem(at: destination) }
                try fm.moveItem(at: backup, to: destination)
            } else if !manifest.hadOriginal[index], !(try exists(staged)), try exists(destination) {
                try fm.removeItem(at: destination)
            }
        }
        // Keep the authoritative manifest until every root has recovered.
        for root in roots.reversed() {
            let work = try directory(root, token: manifest.token)
            if try exists(work) { try fm.removeItem(at: work) }
        }
    }

    private func pruneManagedFiles(in directory: URL) throws {
        for child in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            if child.lastPathComponent.hasPrefix(".") { continue }
            let attributes = try fm.attributesOfItem(atPath: child.path)
            if attributes[.type] as? FileAttributeType == .typeDirectory {
                try pruneManagedFiles(in: child)
                if try fm.contentsOfDirectory(atPath: child.path).isEmpty { try fm.removeItem(at: child) }
            } else {
                // Removing a symlink removes only the link, never its target.
                try fm.removeItem(at: child)
            }
        }
    }
}
