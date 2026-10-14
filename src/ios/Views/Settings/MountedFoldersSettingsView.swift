//
//  MountedFoldersSettingsView.swift
//  MinisApp
//
//  Settings screen for managing user-mounted external folders. Lets the user
//  pick a folder from iOS Files (e.g. an Obsidian vault in iCloud Drive),
//  give it a custom name, and mount it at /var/minis/mounts/<name>.
//

import SwiftUI
import UIKit
import UniformTypeIdentifiers

private let mountUILogger = AppLogger(category: "MountedFoldersUI")

/// Wrapper so we can drive the Add-Mount sheet via `.sheet(item:)`, which
/// guarantees the URL is present when the sheet is constructed. Using two
/// stacked `.sheet(isPresented:)` modifiers races on first pick: the
/// AddMountSheet is built before `pendingPickedURL` has propagated, so its
/// "Source path" section renders empty until the next attempt.
private struct PendingMount: Identifiable {
    let id = UUID()
    let url: URL
    var name: String
    var allowWrite: Bool
}

struct MountedFoldersSettingsView: View {
    @StateObject private var model = MountedFoldersViewModel()
    @State private var showingPicker = false
    @State private var pendingMount: PendingMount?
    @State private var errorText: String?

    var body: some View {
        List {
            Section {
                InfoBanner()
            }

            if model.entries.isEmpty {
                Section {
                    LeoEmptyState(systemImage: "externaldrive.badge.plus",
                                  title: String(localized: "No mounted folders"),
                                  message: String(localized: "Tap + to pick a folder from Files (e.g. an Obsidian vault in iCloud Drive)."))
                }
            } else {
                Section {
                    ForEach(model.entries) { entry in
                        NavigationLink {
                            MountDetailView(
                                context: detailContext(for: entry),
                                onDismiss: { model.refresh() }
                            )
                        } label: {
                            MountedFolderRow(
                                entry: entry,
                                state: model.state(for: entry.id),
                                sourceURL: model.resolvedURL(for: entry.id),
                                needsReauthorization: model.needsReauthorization(entry),
                                isRetrying: model.retrying.contains(entry.id),
                                onRetry: { model.retry(id: entry.id) }
                            )
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                model.remove(id: entry.id)
                            } label: {
                                Label("Remove", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text("Mounted Folders")
                        Spacer()
                        Text("\(model.entries.count) / \(MountedFoldersManager.maxMountCount)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(model.isAtCapacity ? .orange : .secondary)
                    }
                } footer: {
                    if model.isAtCapacity {
                        Text("Mount limit reached. Remove an existing mount before adding a new one.")
                            .foregroundStyle(.orange)
                    }
                }
            }
        }
        .navigationTitle("Mount External Folders")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    showingPicker = true
                } label: {
                    Image(systemName: "plus")
                }
                .disabled(model.isAtCapacity)
            }
        }
        .sheet(isPresented: $showingPicker) {
            FolderPicker { url in
                // `UIDocumentPickerViewController` fires its `didPickDocumentsAt`
                // delegate *after* SwiftUI has already started dismissing the
                // sheet, but we still need to wait until the dismissal fully
                // finishes before presenting a second sheet — iOS refuses to
                // stack two sheets, so assigning `pendingMount` synchronously
                // here silently drops the presentation on first try.
                // Hopping to the next run loop tick lets the picker sheet
                // finish leaving the hierarchy first.
                mountUILogger.info("FolderPicker onPick url=\(url.path)")
                DispatchQueue.main.async {
                    let pm = PendingMount(
                        url: url,
                        name: Self.defaultMountName(for: url),
                        // Read-only until the user opts in: a mount points
                        // at the user's real files (iCloud Drive, Obsidian…).
                        allowWrite: false
                    )
                    mountUILogger.info("async assign pendingMount id=\(pm.id.uuidString) url=\(url.path)")
                    pendingMount = pm
                }
            }
        }
        .sheet(item: $pendingMount) { pending in
            // IMPORTANT: read from the `pending` closure parameter, not from
            // `pendingMount?.url` — the Optional state binding can be
            // momentarily nil while SwiftUI re-routes the sheet, which blanks
            // out the Source Path field.
            AddMountSheet(
                sourceURL: pending.url,
                name: Binding(
                    get: { pendingMount?.name ?? pending.name },
                    set: { pendingMount?.name = $0 }
                ),
                allowWrite: Binding(
                    get: { pendingMount?.allowWrite ?? pending.allowWrite },
                    set: { pendingMount?.allowWrite = $0 }
                ),
                onCancel: {
                    pendingMount = nil
                },
                onConfirm: {
                    let current = pendingMount ?? pending
                    do {
                        _ = try model.add(
                            pickedURL: current.url,
                            customName: current.name,
                            userAllowWrite: current.allowWrite
                        )
                    } catch {
                        errorText = error.localizedDescription
                    }
                    pendingMount = nil
                }
            )
        }
        .alert(String(localized: "Error"),
               isPresented: Binding(get: { errorText != nil },
                                    set: { if !$0 { errorText = nil } })) {
            Button(String(localized: "OK"), role: .cancel) { errorText = nil }
        } message: {
            Text(errorText ?? "")
        }
        .task { await refreshWhileChecking() }
    }

    /// [T-mount-state-pending] Launch-time resolution finishes in the
    /// background. Refresh on appear, then keep refreshing (≤ 20 s) while a
    /// row still shows "checking", so the result shows up without reopening.
    private func refreshWhileChecking() async {
        model.refresh()
        for _ in 0..<20 where model.hasPendingStates {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { return }
            model.refresh()
        }
    }

    /// Build the MountDetailView context for an external-mount entry.
    private func detailContext(for entry: MountedFolderEntry) -> MountDetailContext {
        // Host URL for Browse Files goes through the fakefs symlink so the
        // breadcrumb shows /var/minis/mounts/<name>.
        let mountPath = RootfsManager.shared.dataPath
            .appendingPathComponent("var/minis/mounts", isDirectory: true)
            .appendingPathComponent(entry.name)
        return MountDetailContext(
            kind: .external,
            linuxPath: "/var/minis/mounts/\(entry.name)",
            sourceDisplayName: entry.sourceDisplayName,
            hostURL: mountPath,
            iconName: "externaldrive.fill",
            iconColor: .orange,
            subtitle: nil,
            initialName: entry.name,
            canRename: true,
            externalMountId: entry.id,
            isOSWritable: entry.isWritable,
            initialUserAllowWrite: entry.userAllowWrite,
            sharedFolderName: nil,
            initialVisibleInFiles: true,
            isReadOnlyFromFiles: false
        )
    }

    /// Trivial / meaningless segments often appearing at the end of an iCloud
    /// container identifier's reverse-DNS bundle ID (e.g. `iCloud~com~nssurge~inc`
    /// where "inc" is just the company suffix). We skip these when picking a
    /// friendly default mount name.
    private static let trivialSuffixes: Set<String> = [
        "inc", "ltd", "llc", "app", "co", "corp", "gmbh"
    ]

    /// Default mount name suggestion.
    ///
    /// When the user picks an iCloud Drive app folder, `url.lastPathComponent`
    /// is often literally "Documents" because Apple's ubiquity container
    /// structure is:
    ///     .../Mobile Documents/iCloud~<team>~<bundle-parts>/Documents/
    ///
    /// Using "Documents" as the mount name gives no hint about which app the
    /// folder belongs to. We detect that case and instead derive the name
    /// from the parent container, picking the most meaningful segment of the
    /// reverse-DNS bundle ID (e.g. `iCloud~com~nssurge~inc` → `nssurge`, not
    /// `inc`).
    private static func defaultMountName(for url: URL) -> String {
        let lastName = url.lastPathComponent
        let candidate: String
        if lastName == "Documents" {
            // Walk up: parent is the ubiquity container directory.
            let parent = url.deletingLastPathComponent()
            let parentName = parent.lastPathComponent
            if parentName.hasPrefix("iCloud~") {
                // Format: "iCloud~<team>~<bundle-component-1>~<bundle-component-2>..."
                // Drop the "iCloud" prefix and the TLD-like team segment
                // (index 1, usually "com" / "net" / "org" / "io" / "md").
                let parts = parentName.split(separator: "~").map(String.init)
                let remaining = Array(parts.dropFirst(2)) // drop "iCloud" + team
                // Prefer the last segment that isn't a trivial corporate suffix.
                let best = remaining.reversed().first { segment in
                    !Self.trivialSuffixes.contains(segment.lowercased())
                } ?? remaining.last ?? parts.last ?? lastName
                candidate = best
            } else if !parentName.isEmpty {
                // Not an iCloud container but still called Documents —
                // fall back to the parent name for disambiguation.
                candidate = parentName
            } else {
                candidate = lastName
            }
        } else {
            candidate = lastName
        }

        let cleaned = candidate
            .trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "/", with: "-")
        return cleaned.isEmpty ? "mount" : cleaned
    }
}

// MARK: - Banner

private struct InfoBanner: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Mount external folders", systemImage: "info.circle")
                .font(.subheadline.weight(.semibold))
            Text("Picked folders are bind-mounted at /var/minis/mounts/<name>. You can browse them in Browse Files and read/write them directly from the iSH shell, just like /var/minis/shared. Up to 10 folders can be mounted at a time.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Row

private struct MountedFolderRow: View {
    let entry: MountedFolderEntry
    /// nil while the mount is still being resolved.
    let state: MountActivationState?
    let sourceURL: URL?
    /// [T-mount-backoff] 连续失败、现在没在用:授权多半已经失效,自动重试已按退避暂停。
    var needsReauthorization = false
    /// 手动重试正在后台解析书签。
    var isRetrying = false
    var onRetry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Image(systemName: "folder.fill")
                    .foregroundStyle(.blue)
                Text(entry.name)
                    .font(.body.weight(.medium))
                accessBadge
                if needsReauthorization && !isRetrying {
                    LeoCapsuleBadge(text: String(localized: "需要重新授权"),
                                    systemImage: "key.fill",
                                    tint: LeoTheme.ColorToken.warning)
                }
                Spacer()
            }
            Text("/var/minis/mounts/\(entry.name)")
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(verbatim: "← \(sourceURL?.path ?? entry.sourceDisplayName)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
            if isRetrying || state == nil {
                Label(String(localized: "Checking access…"), systemImage: "clock")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if needsReauthorization {
                // 和别处失败提示同一个组件(LeoInlineError):说清发生了什么 + 一个重试入口。
                // 重试会清零退避、在后台重新解析书签;仍失败就换成删掉后重新选择文件夹。
                LeoInlineError(
                    message: String(localized: "这个文件夹的授权已失效,已暂停自动重试。点「重试」再试一次;仍然失败的话,请删除这个挂载后重新选择文件夹。"),
                    retryTitle: String(localized: "重试"),
                    onRetry: onRetry,
                    style: .card
                )
                .padding(.top, 2)
            } else if let problem = stateProblem {
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 2)
    }

    private var stateProblem: String? {
        switch state {
        case .none, .active: return nil
        case .stale:
            return String(localized: "The folder moved or was renamed. Remove this mount and pick the folder again.")
        case .permissionDenied:
            return String(localized: "Access to this folder was revoked. Remove this mount and pick the folder again.")
        case .contentsUnavailable:
            return String(localized: "The folder's contents aren't downloaded. Open it once in the Files app, then come back.")
        case .failed(let reason):
            return String(localized: "Couldn't mount: \(reason)")
        }
    }

    /// Small pill reflecting the effective write state of this mount:
    /// - "R/W": the OS allows writes AND the user allowed writes
    /// - "Locked": the OS allows writes but the user set Allow Writes = off
    /// - "Read-only": the OS itself does not allow writes (user choice n/a)
    @ViewBuilder
    private var accessBadge: some View {
        if !entry.isWritable {
            badgePill(text: String(localized: "Read-only"), color: .orange)
        } else if !entry.userAllowWrite {
            badgePill(text: String(localized: "Locked"), color: .purple)
        } else {
            badgePill(text: String(localized: "R/W"), color: .green)
        }
    }

    private func badgePill(text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(
                Capsule().strokeBorder(color.opacity(0.5), lineWidth: 1)
            )
    }
}

// MARK: - Add mount sheet

private struct AddMountSheet: View {
    let sourceURL: URL?
    @Binding var name: String
    @Binding var allowWrite: Bool
    let onCancel: () -> Void
    let onConfirm: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                if let url = sourceURL {
                    Section {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Source path")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(url.path)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.primary)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.vertical, 2)
                    } footer: {
                        Text("The path above is how iOS exposes the folder you picked. Use it to confirm which app this data belongs to.")
                            .font(.caption2)
                    }
                }

                Section(header: Text("Mount name")) {
                    TextField("name", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Text("This will be the folder name under /var/minis/mounts/")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section {
                    Toggle(isOn: $allowWrite) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Allow writes")
                            Text(allowWrite
                                ? String(localized: "AI, shell, and Files browser can modify files in this mount.")
                                : String(localized: "This mount will be exposed as read-only. Useful for reference vaults you don't want the AI to touch."))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Permissions")
                } footer: {
                    Text("You can change the write permission later from the mount details page.")
                        .font(.caption)
                }
            }
            .navigationTitle("New Mount")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel"), action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(String(localized: "Mount"), action: onConfirm)
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

// MARK: - Folder picker

private struct FolderPicker: UIViewControllerRepresentable {
    let onPick: (URL) -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
        picker.delegate = context.coordinator
        picker.allowsMultipleSelection = false
        return picker
    }

    func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPick: (URL) -> Void
        init(onPick: @escaping (URL) -> Void) { self.onPick = onPick }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            guard let url = urls.first else { return }
            onPick(url)
        }
    }
}

// MARK: - ViewModel

@MainActor
final class MountedFoldersViewModel: ObservableObject {
    @Published private(set) var entries: [MountedFolderEntry] = []
    @Published private(set) var states: [UUID: MountActivationState] = [:]

    var isAtCapacity: Bool {
        entries.count >= MountedFoldersManager.maxMountCount
    }

    init() {
        refresh()
    }

    func refresh() {
        entries = MountedFoldersManager.shared.entries
        states = MountedFoldersManager.shared.activationStates
    }

    /// nil = not resolved yet. [T-mount-state-pending] Mounts are resolved
    /// asynchronously at launch (up to 5 s each), so "no state" means
    /// "still checking", not "couldn't mount" — defaulting to `.failed("")`
    /// flagged every healthy mount with a warning until the page was reopened.
    func state(for id: UUID) -> MountActivationState? {
        states[id]
    }

    /// True while some mount has no resolution result yet.
    var hasPendingStates: Bool {
        entries.contains { states[$0.id] == nil }
    }

    /// [T-mount-backoff] 正在手动重试的挂载(后台解析书签,最长约 5 秒)。
    @Published private(set) var retrying: Set<UUID> = []

    /// 这个挂载需要用户重新授权:有连续失败记录,而且现在没有在用。
    /// (失败记录持久化在 MountedFolderEntry 里,所以冷启动后、解析还没跑完之前也能立刻判断。)
    func needsReauthorization(_ entry: MountedFolderEntry) -> Bool {
        guard entry.hasFailureStreak else { return false }
        return !(states[entry.id]?.isActive ?? false)
    }

    /// 手动重试:清零退避,在后台重新解析书签(带超时,不占主线程);完成后刷新这一页。
    func retry(id: UUID) {
        guard !retrying.contains(id) else { return }
        retrying.insert(id)
        Task {
            await MountedFoldersManager.shared.retryActivation(id: id)
            retrying.remove(id)
            refresh()
        }
    }

    /// Resolved host URL for a mount, if currently active. Exposed to row views
    /// so they can display the underlying iOS filesystem path.
    func resolvedURL(for id: UUID) -> URL? {
        MountedFoldersManager.shared.resolvedURL(for: id)
    }

    @discardableResult
    func add(pickedURL: URL, customName: String, userAllowWrite: Bool) throws -> MountedFolderEntry {
        // The document picker gives a URL with scope active; start it once more
        // defensively so MountedFoldersManager's bookmarkData call inside succeeds.
        let started = pickedURL.startAccessingSecurityScopedResource()
        defer { if started { pickedURL.stopAccessingSecurityScopedResource() } }
        let entry = try MountedFoldersManager.shared.add(
            pickedURL: pickedURL,
            customName: customName,
            userAllowWrite: userAllowWrite
        )
        refresh()
        return entry
    }

    func remove(id: UUID) {
        MountedFoldersManager.shared.remove(id: id)
        refresh()
    }

    func rename(id: UUID, to newName: String) throws {
        try MountedFoldersManager.shared.rename(id: id, to: newName)
        refresh()
    }

    func setUserAllowWrite(id: UUID, to allow: Bool) {
        MountedFoldersManager.shared.setUserAllowWrite(id: id, to: allow)
        refresh()
    }
}
