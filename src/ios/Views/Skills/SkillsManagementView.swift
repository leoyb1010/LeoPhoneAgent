//
//  SkillsManagementView.swift
//  MinisApp
//
//  Settings-level skill management: list, import, edit, delete.
//

import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Sort options for the skills list. Mirrors the file browser's sort menu
/// (FileSortKey) with the two keys that make sense for skills.
enum SkillSortKey: String, CaseIterable, Identifiable {
    case name
    case modified

    var id: String { rawValue }

    var label: LocalizedStringKey {
        switch self {
        case .name: return "Name"
        case .modified: return "Date Modified"
        }
    }
}

struct SkillsManagementView: View {
    @ObservedObject private var store = SkillStore.shared
    @State private var showImportSheet = false
    @State private var showSkillsBrowser = false
    /// [T-skill-catalog] Built-in recommended skills directory.
    @State private var showSkillCatalog = false
    @State private var searchQuery = ""
    @State private var forceSyncAllToast: String?
    /// Subscribed mirror of `SyncV2Bootstrap.isEnabled` so the
    /// Force-iCloud-Sync menu entry shows / hides reactively when
    /// the user flips the toggle in Settings.
    @AppStorage("cloudSync.v2.enabled") private var iCloudSyncEnabled: Bool = false
    @AppStorage("skillsList.sortKey") private var sortKeyRaw: String = SkillSortKey.name.rawValue
    @AppStorage("skillsList.sortAscending") private var sortAscending: Bool = true

    private var filteredSkills: [Skill] {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let base = q.isEmpty ? store.skills : store.skills.filter {
            $0.name.lowercased().contains(q) || $0.description.lowercased().contains(q)
        }
        let key = SkillSortKey(rawValue: sortKeyRaw) ?? .name
        let sorted: [Skill]
        switch key {
        case .name:
            sorted = base.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        case .modified:
            sorted = base.sorted { $0.updatedAt < $1.updatedAt }
        }
        return sortAscending ? sorted : sorted.reversed()
    }

    var body: some View {
        List {
            if store.skills.isEmpty {
                Section {
                    Text(String(localized: "No skills installed. Tap + to import a SKILL.md from GitHub or paste one manually."))
                        .foregroundStyle(.secondary)
                        .font(.subheadline)
                }
            } else if filteredSkills.isEmpty {
                Section {
                    Text(String(localized: "No skills match \"\(searchQuery)\"."))
                        .foregroundStyle(.secondary)
                        .font(.subheadline)
                }
            }

            ForEach(filteredSkills) { skill in
                NavigationLink {
                    SkillDetailView(skillId: skill.id)
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 4) {
                                Text(skill.name).font(.body)
                                importSourceBadge(skill.importSource)
                            }
                            if !skill.description.isEmpty {
                                Text(skill.description)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                        Spacer()
                        Toggle("", isOn: Binding(
                            get: { skill.isEnabled },
                            set: { store.setEnabled(skill.id, enabled: $0) }
                        ))
                        .labelsHidden()
                    }
                }
            }
            .onDelete { offsets in
                let ids = offsets.map { filteredSkills[$0].id }
                for id in ids { store.deleteSkill(id) }
            }
        }
        .navigationTitle("Skills")
        .searchable(text: $searchQuery, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: Text(String(localized: "Search skills")))
        .onAppear { store.reload() }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // Sort menu — same structure as the file browser's (sort-key
                // picker + direction toggle), persisted via AppStorage.
                Menu {
                    Picker(selection: $sortKeyRaw) {
                        ForEach(SkillSortKey.allCases) { key in
                            Text(key.label).tag(key.rawValue)
                        }
                    } label: {
                        Text("Sort By")
                    }
                    Button {
                        sortAscending.toggle()
                    } label: {
                        Label(
                            sortAscending ? "Ascending" : "Descending",
                            systemImage: sortAscending ? "arrow.up" : "arrow.down"
                        )
                    }
                } label: {
                    Image(systemName: "arrow.up.arrow.down")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        showSkillCatalog = true
                    } label: {
                        Label("推荐 Skill 目录", systemImage: "square.grid.2x2")
                    }
                    Button {
                        showImportSheet = true
                    } label: {
                        Label(String(localized: "Import Skill"), systemImage: "square.and.arrow.down")
                    }
                    Button {
                        showSkillsBrowser = true
                    } label: {
                        Label(String(localized: "LeoPhoneAgent Skills"), systemImage: "globe")
                    }
                    // Skill iCloud sync is wired through SyncV2; hide the
                    // force-sync entry entirely when the user has the
                    // feature off in Settings (no-op otherwise).
                    if #available(iOS 17.0, *), iCloudSyncEnabled {
                        Divider()
                        Button {
                            forceSyncAllSkills()
                        } label: {
                            Label(String(localized: "Force iCloud Sync All"), systemImage: "icloud.and.arrow.up")
                        }
                    }
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showImportSheet) {
            ImportSkillSheet()
        }
        .sheet(isPresented: $showSkillCatalog, onDismiss: { store.reload() }) {
            SkillCatalogSheet()
        }
        .fullScreenCover(isPresented: $showSkillsBrowser, onDismiss: {
            store.reload()
        }) {
            MinisSkillsBrowserView()
        }
        .overlay(alignment: .top) {
            if let msg = forceSyncAllToast {
                Text(msg)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(Color.accentColor, in: Capsule())
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.3), value: forceSyncAllToast)
    }

    private func forceSyncAllSkills() {
        let count = store.skills.count
        for s in store.skills { store.forceMarkDirty(s.id) }
        SyncCore.shared.scheduleSend(delay: 0.5)
        forceSyncAllToast = String(localized: "Queued \(count) skills for sync")
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { forceSyncAllToast = nil }
    }

    @ViewBuilder
    private func importSourceBadge(_ source: SkillImportSource) -> some View {
        switch source {
        case .url:
            Image(systemName: "link")
                .font(.caption2)
                .foregroundStyle(.blue)
        case .file:
            Image(systemName: "doc")
                .font(.caption2)
                .foregroundStyle(.orange)
        case .bundled:
            Image(systemName: "shippingbox")
                .font(.caption2)
                .foregroundStyle(.green)
        case .session:
            Image(systemName: "bubble.left.and.text.bubble.right")
                .font(.caption2)
                .foregroundStyle(.purple)
        }
    }
}

// MARK: - Import Sheet

private struct ImportSkillSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var importMode: ImportMode = .url
    @State private var urlText = ""
    @State private var pastedContent = ""
    @State private var isImporting = false
    @State private var errorMessage: String?
    @State private var showFilePicker = false

    enum ImportMode: String, CaseIterable {
        case url = "URL"
        case paste = "Paste"
        case file = "File"
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker("Import Method", selection: $importMode) {
                    ForEach(ImportMode.allCases, id: \.self) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                .padding(.horizontal)

                switch importMode {
                case .url:
                    Section("GitHub URL") {
                        TextField("", text: $urlText, prompt: Text("github.com/user/repo/blob/main/SKILL.md").foregroundColor(.secondary))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .tint(.primary)
                    }

                case .paste:
                    Section("SKILL.md Content") {
                        TextEditor(text: $pastedContent)
                            .font(.system(.caption, design: .monospaced))
                            .frame(minHeight: 200)
                    }

                case .file:
                    Section(footer: Text(String(localized: "Supports SKILL.md, .skill, and .zip files."))) {
                        Button(String(localized: "Choose File…")) {
                            showFilePicker = true
                        }
                    }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                }
            }
            .navigationTitle(String(localized: "Import Skill"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(String(localized: "Cancel")) { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if importMode != .file {
                        Button(String(localized: "Import")) { performImport() }
                            .disabled(isImporting || (importMode == .url ? urlText.isEmpty : pastedContent.isEmpty))
                    }
                }
            }
            .overlay {
                if isImporting {
                    ProgressView("Importing…")
                        .padding()
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .sheet(isPresented: $showFilePicker) {
                SkillFileDocumentPicker { result in
                    do {
                        switch result {
                        case .text(let content):
                            _ = try SkillStore.shared.importSkill(content: content, source: .file)
                        case .archiveURL(let url):
                            _ = try SkillStore.shared.importFromArchive(at: url)
                            try? FileManager.default.removeItem(at: url)
                        }
                        dismiss()
                    } catch {
                        errorMessage = error.localizedDescription
                    }
                }
            }
        }
    }

    private func performImport() {
        errorMessage = nil
        isImporting = true

        Task { @MainActor in
            do {
                switch importMode {
                case .url:
                    _ = try await SkillStore.shared.importFromGitHub(urlString: urlText.trimmingCharacters(in: .whitespacesAndNewlines))
                case .paste:
                    _ = try SkillStore.shared.importSkill(content: pastedContent, source: .file)
                case .file:
                    break // handled by file picker
                }
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
            isImporting = false
        }
    }
}

// MARK: - File Picker

/// Callback receives either a plain-text SKILL.md content string or a file URL for archives.
private enum SkillFilePickResult {
    case text(String)
    case archiveURL(URL)
}

private struct SkillFileDocumentPicker: UIViewControllerRepresentable {
    let onImport: (SkillFilePickResult) -> Void

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        var types: [UTType] = [.plainText, .zip]
        // .skill files are zip archives with a custom extension
        if let skillType = UTType(filenameExtension: "skill", conformingTo: .zip) {
            types.append(skillType)
        }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onImport: onImport) }

    class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onImport: (SkillFilePickResult) -> Void
        init(onImport: @escaping (SkillFilePickResult) -> Void) { self.onImport = onImport }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            guard let url = urls.first else { return }
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }

            let ext = url.pathExtension.lowercased()
            if ext == "zip" || ext == "skill" {
                // Copy to temp so we can access after security scope ends
                let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(url.lastPathComponent)
                try? FileManager.default.removeItem(at: tmp)
                if let _ = try? FileManager.default.copyItem(at: url, to: tmp) {
                    onImport(.archiveURL(tmp))
                }
            } else if let content = try? String(contentsOf: url, encoding: .utf8) {
                onImport(.text(content))
            }
        }
    }
}

// MARK: - Settings-style row icon

/// A circular colored badge with a white SF Symbol centered inside, used for
/// the skill detail action rows instead of a bare tinted glyph.
/// [T-skill-detail-icons][T-skill-icon-circular] Spec is copied VERBATIM from
/// the main Settings page rows (ContentView Agent Runtime / Appearance
/// sections): 9pt default-weight white glyph in a 21×21 colored circle —
/// keep the two surfaces identical; don't retune one without the other.
private struct SettingsActionIcon: View {
    let systemImage: String
    let color: Color

    var body: some View {
        Image(systemName: systemImage)
            .font(.system(size: 9))
            .foregroundStyle(.white)
            .frame(width: 21, height: 21)
            .background(color, in: Circle())
    }
}

// MARK: - Skill Detail View

private struct SkillDetailView: View {
    let skillId: String
    @ObservedObject private var store = SkillStore.shared
    @State private var isUpdating = false
    @State private var showFilePicker = false
    @State private var updateError: String?
    @State private var updatedAgoText: String = ""
    @State private var shareZipURL: URL?
    @State private var editingName: String = ""
    @State private var isEditingName = false
    @State private var showRescanDone = false
    @State private var showForceSyncDone = false
    @State private var showDeleteConfirm = false
    @Environment(\.dismiss) private var dismiss
    /// Mirrors `SyncV2Bootstrap.isEnabled` so the per-skill Force iCloud
    /// Sync button shows / hides reactively when the user flips the
    /// iCloud Sync toggle in Settings. Same gating predicate used by
    /// the parent SkillsManagementView plus-menu (commit 47fd61ef).
    @AppStorage("cloudSync.v2.enabled") private var iCloudSyncEnabled: Bool = false

    private var skill: Skill? {
        store.skills.first(where: { $0.id == skillId })
    }

    /// First 5 non-empty lines of the skill body (frontmatter already stripped)
    private var bodyPreview: String {
        guard let skill else { return "" }
        let nonEmpty = skill.body
            .components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        let lines = Array(nonEmpty.prefix(5))
        let preview = lines.joined(separator: "\n")
        let hasMore = nonEmpty.count > 5
        return hasMore ? preview + "\n…" : preview
    }

    private var skillFiles: [String] {
        store.listSkillFiles(skillId)
    }

    private static func relativeTime(_ date: Date) -> String {
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "just now" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes) min ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours) hr ago" }
        let days = hours / 24
        return "\(days) day\(days == 1 ? "" : "s") ago"
    }

    /// Latest modification date across all files in the skill directory.
    private var latestFileModDate: Date? {
        let dir = store.skillDirectoryURL(for: skillId)
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: dir,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return nil }
        var latest: Date?
        for case let fileURL as URL in enumerator {
            if let date = (try? fileURL.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate {
                if latest == nil || date > latest! { latest = date }
            }
        }
        return latest
    }

    var body: some View {
        List {
            if let skill {
                // ── Meta ──────────────────────────────────────────────
                Section {
                    HStack {
                        Text(String(localized: "Name"))
                        Spacer()
                        if isEditingName {
                            TextField("Skill name", text: $editingName, onCommit: {
                                commitNameEdit()
                            })
                            .textFieldStyle(.roundedBorder)
                            .frame(maxWidth: 200)
                            .submitLabel(.done)
                        } else {
                            Text(skill.name)
                                .foregroundStyle(skill.name == SkillStore.defaultSkillName ? .red : .secondary)
                            Button {
                                editingName = skill.name == SkillStore.defaultSkillName ? "" : skill.name
                                isEditingName = true
                            } label: {
                                Image(systemName: "pencil")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    LabeledContent("Version", value: skill.version)
                    if let modDate = latestFileModDate {
                        LabeledContent("Last Modified") {
                            Text(Self.relativeTime(modDate))
                                .foregroundStyle(.secondary)
                        }
                    }
                    LabeledContent("Source") {
                        switch skill.importSource {
                        case .url(let url):
                            Text(url)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        case .file:
                            Text(String(localized: "File import")).foregroundStyle(.secondary)
                        case .bundled:
                            Text(String(localized: "Built-in")).foregroundStyle(.secondary)
                        case .session:
                            Text(String(localized: "Session created")).foregroundStyle(.secondary)
                        }
                    }
                    LabeledContent(String(localized: "Usage")) {
                        let freq = store.usageFrequency(for: skill.id)
                        Text(usageFrequencyLabel(freq))
                            .foregroundStyle(usageFrequencyColor(freq))
                    }
                }

                // ── Update actions ────────────────────────────────────
                Section {
                    if case .url = skill.importSource {
                        Button { updateFromURL() } label: {
                            HStack {
                                Label("Update from URL", systemImage: "arrow.triangle.2.circlepath")
                                Spacer()
                                if isUpdating {
                                    ProgressView()
                                } else {
                                    Text(updatedAgoText)
                                        .foregroundStyle(.secondary)
                                        .font(.caption)
                                }
                            }
                        }
                        .disabled(isUpdating)
                    }

                    Button { showFilePicker = true } label: {
                        Label {
                            Text("Update from File…")
                        } icon: {
                            SettingsActionIcon(systemImage: "doc.badge.arrow.up", color: .blue)
                        }
                    }

                    Button {
                        store.rescanFromDisk(skillId)
                        showRescanDone = true
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { showRescanDone = false }
                    } label: {
                        HStack {
                            Label {
                                Text("Rescan from Disk")
                            } icon: {
                                SettingsActionIcon(systemImage: "arrow.clockwise", color: .orange)
                            }
                            Spacer()
                            if showRescanDone {
                                Text(String(localized: "Done")).foregroundStyle(.green).font(.caption)
                            }
                        }
                    }

                    // Same iCloud-toggle gate the parent SkillsManagementView
                    // plus-menu uses (47fd61ef). Hide the button outright
                    // when iCloud sync is disabled — the action would no-op
                    // (markDirty + scheduleSend on a disabled engine).
                    if #available(iOS 17.0, *), iCloudSyncEnabled {
                        Button {
                            store.forceMarkDirty(skillId)
                            SyncCore.shared.scheduleSend(delay: 0.5)
                            showForceSyncDone = true
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { showForceSyncDone = false }
                        } label: {
                            HStack {
                                Label {
                                    Text(String(localized: "Force iCloud Sync"))
                                } icon: {
                                    SettingsActionIcon(systemImage: "icloud.and.arrow.up", color: .indigo)
                                }
                                Spacer()
                                if showForceSyncDone {
                                    Text(String(localized: "Queued")).foregroundStyle(.green).font(.caption)
                                }
                            }
                        }
                    }
                }

                // ── Body preview ──────────────────────────────────────
                if !bodyPreview.isEmpty {
                    Section("Description") {
                        Text(bodyPreview)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .lineLimit(nil)
                    }
                }

                // ── File list ─────────────────────────────────────────
                Section("Files") {
                    ForEach(skillFiles, id: \.self) { relativePath in
                        NavigationLink {
                            SkillFileDetailView(skillId: skillId, relativePath: relativePath)
                        } label: {
                            Label {
                                Text(relativePath)
                                    .font(.system(.subheadline, design: .monospaced))
                            } icon: {
                                Image(systemName: fileIcon(for: relativePath))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if let updateError {
                    Section {
                        Text(updateError).foregroundStyle(.red).font(.caption)
                    }
                }

                // ── Delete ───────────────────────────────────────────
                Section {
                    Button(role: .destructive) {
                        showDeleteConfirm = true
                    } label: {
                        HStack {
                            Spacer()
                            Label(String(localized: "Delete Skill"), systemImage: "trash")
                            Spacer()
                        }
                    }
                }
            } else {
                Text(String(localized: "Skill not found.")).foregroundStyle(.secondary)
            }
        }
        .navigationTitle(skill?.name ?? "Skill")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { shareSkill() } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .disabled(skill == nil)
            }
        }
        .onAppear { refreshUpdatedAgo() }
        .sheet(isPresented: Binding(get: { shareZipURL != nil }, set: { if !$0 { cleanupShareZip() } })) {
            if let url = shareZipURL {
                ActivityView(activityItems: [url]) {
                    cleanupShareZip()
                }
            }
        }
        .sheet(isPresented: $showFilePicker) {
            SkillFileDocumentPicker { result in
                do {
                    switch result {
                    case .text(let newContent):
                        try store.updateSkillContent(skillId, newContent: newContent)
                    case .archiveURL(let url):
                        _ = try store.importFromArchive(at: url)
                        try? FileManager.default.removeItem(at: url)
                    }
                    updateError = nil
                } catch {
                    updateError = error.localizedDescription
                }
            }
        }
        .alert(String(localized: "Delete Skill"), isPresented: $showDeleteConfirm) {
            Button(String(localized: "Delete"), role: .destructive) {
                store.deleteSkill(skillId)
                dismiss()
            }
            Button(String(localized: "Cancel"), role: .cancel) {}
        } message: {
            Text(String(localized: "Are you sure you want to delete this skill? This action cannot be undone."))
        }
    }

    private func usageFrequencyLabel(_ freq: SkillStore.UsageFrequency) -> String {
        switch freq {
        case .never:  return String(localized: "Never Used")
        case .low:    return String(localized: "Low Usage")
        case .regular: return String(localized: "Regular Usage")
        case .high:   return String(localized: "High Usage")
        }
    }

    private func usageFrequencyColor(_ freq: SkillStore.UsageFrequency) -> Color {
        switch freq {
        case .never:  return .secondary
        case .low:    return .blue
        case .regular: return .orange
        case .high:   return .green
        }
    }

    private func commitNameEdit() {
        isEditingName = false
        let newName = editingName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !newName.isEmpty, let skill, newName != skill.name else { return }
        store.renameSkill(skillId, newName: newName)
    }

    private func fileIcon(for path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "md":   return "doc.text"
        case "py":   return "doc.plaintext"
        case "sh":   return "terminal"
        case "json": return "curlybraces"
        case "yaml", "yml": return "list.bullet.indent"
        case "png", "jpg", "jpeg", "gif", "webp": return "photo"
        default:     return "doc"
        }
    }

    private func updateFromURL() {
        isUpdating = true
        updateError = nil
        Task { @MainActor in
            do {
                try await store.updateFromURL(skillId)
            } catch {
                updateError = error.localizedDescription
            }
            isUpdating = false
            refreshUpdatedAgo()
        }
    }

    private func cleanupShareZip() {
        // [T-mac-share-save-race] Do NOT delete the exported zip here. On Mac
        // (Designed for iPad) the share popover closes — firing BOTH this
        // sheet-dismiss path and completionWithItemsHandler — BEFORE the
        // out-of-process "Save" folder panel / "Copy" file-promise consumer
        // has actually read the file. Deleting on dismissal raced that
        // consumer: the user picked a folder and nothing landed (and pasting
        // into a mounted folder failed), intermittently — small zips
        // sometimes won the race. Exports live in per-share directories
        // under tmp/ and are swept by sweepStaleSkillExports() after 24h
        // (plus the system's own tmp purge), so nothing leaks.
        shareZipURL = nil
    }

    /// [T-mac-share-save-race] Remove skill-export tmp directories older than
    /// 24h. Called before each new export — by then any pending Save/Copy/
    /// AirDrop consumer of an old export has long finished.
    private static func sweepStaleSkillExports() {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: fm.temporaryDirectory,
            includingPropertiesForKeys: [.contentModificationDateKey]
        ) else { return }
        let cutoff = Date().addingTimeInterval(-24 * 3600)
        for url in entries where url.lastPathComponent.hasPrefix("skill-export-") {
            let mod = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            if mod < cutoff {
                try? fm.removeItem(at: url)
            }
        }
    }

    private func shareSkill() {
        guard let skill else { return }
        let skillDir = store.skillDirectoryURL(for: skill.id)
        let fm = FileManager.default
        Self.sweepStaleSkillExports()
        // [T-mac-share-save-race] Unique per-export directory so consecutive
        // shares of the same skill never overwrite/delete a zip an earlier
        // share's consumer might still be reading.
        let exportDir = fm.temporaryDirectory
            .appendingPathComponent("skill-export-\(UUID().uuidString)", isDirectory: true)
        // Sanitize the name for a filesystem-safe, single-component zip name.
        let safeName = skill.name
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
        let zipName = "\(safeName.isEmpty ? "skill" : safeName).zip"
        let zipURL = exportDir.appendingPathComponent(zipName)
        do {
            try fm.createDirectory(at: exportDir, withIntermediateDirectories: true)
        } catch {
            updateError = "Failed to create zip: \(error.localizedDescription)"
            return
        }
        do {
            let coordinator = NSFileCoordinator()
            var error: NSError?
            // Surface a copy failure instead of swallowing it with `try?` — a
            // missing/empty zip is exactly what produced the empty save.
            var copyError: Error?
            coordinator.coordinate(readingItemAt: skillDir, options: [.forUploading], error: &error) { tempZipURL in
                do {
                    try FileManager.default.copyItem(at: tempZipURL, to: zipURL)
                } catch {
                    copyError = error
                }
            }
            if let error { throw error }
            if let copyError { throw copyError }
            // Verify the zip materialized and is non-empty before presenting
            // the share sheet, so we never vend an empty file.
            let attrs = try FileManager.default.attributesOfItem(atPath: zipURL.path)
            let size = (attrs[.size] as? Int64) ?? 0
            guard size > 0 else {
                throw NSError(domain: "SkillExport", code: 1,
                              userInfo: [NSLocalizedDescriptionKey: "Exported zip is empty"])
            }
            shareZipURL = zipURL
        } catch {
            updateError = "Failed to create zip: \(error.localizedDescription)"
        }
    }

    private func refreshUpdatedAgo() {
        guard let skill else { updatedAgoText = ""; return }
        let elapsed = Date().timeIntervalSince(skill.updatedAt)
        switch elapsed {
        case ..<60:      updatedAgoText = "just now"
        case ..<3600:    updatedAgoText = "\(Int(elapsed / 60)) min ago"
        case ..<86400:   updatedAgoText = "\(Int(elapsed / 3600)) hr ago"
        default:         updatedAgoText = "\(Int(elapsed / 86400)) days ago"
        }
    }
}

// MARK: - Skill File Detail View

private struct SkillFileDetailView: View {
    let skillId: String
    let relativePath: String

    @ObservedObject private var store = SkillStore.shared
    @State private var content: String = ""
    @State private var hasChanges = false
    @State private var saveError: String?

    private var fileName: String {
        (relativePath as NSString).lastPathComponent
    }

    var body: some View {
        TextEditor(text: $content)
            .font(.system(.caption, design: .monospaced))
            .padding(.horizontal, 8)
            .onChange(of: content) { _ in hasChanges = true }
            .overlay(alignment: .bottom) {
                if let saveError {
                    Text(saveError)
                        .foregroundStyle(.red)
                        .font(.caption)
                        .padding(8)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
                        .padding()
                }
            }
            .navigationTitle(fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if hasChanges {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(String(localized: "Save")) { save() }
                    }
                }
            }
            .onAppear {
                content = store.readSkillFile(skillId, relativePath: relativePath) ?? ""
            }
    }

    private func save() {
        do {
            try store.writeSkillFile(skillId, relativePath: relativePath, content: content)
            hasChanges = false
            saveError = nil
        } catch {
            saveError = error.localizedDescription
        }
    }
}

// MARK: - LeoPhoneAgent Skills Browser

import WebKit

struct MinisSkillsBrowserView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var coordinator = SkillBrowserCoordinator()

    var body: some View {
        NavigationStack {
            ZStack {
                SkillBrowserWebView(coordinator: coordinator)
                    .ignoresSafeArea(edges: .bottom)

                // HUD overlay
                if coordinator.hudState != .hidden {
                    VStack {
                        Spacer()
                        hudView
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                        Spacer().frame(height: 60)
                    }
                    .animation(.spring(response: 0.3), value: coordinator.hudState)
                }
            }
            .navigationTitle("LeoPhoneAgent Skills")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(String(localized: "Done")) { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(String(localized: "Import This")) {
                        coordinator.importCurrentSkill()
                    }
                    .disabled(coordinator.hudState == .importing)
                }
            }
            .alert(String(localized: "Skill Already Exists"), isPresented: $coordinator.showOverwriteConfirm) {
                Button(String(localized: "Update"), role: .destructive) {
                    coordinator.confirmOverwrite()
                }
                Button(String(localized: "Cancel"), role: .cancel) {}
            } message: {
                Text(String(localized: "\"\(coordinator.pendingOverwriteName)\" is already installed. Update to the latest version?"))
            }
        }
    }

    @ViewBuilder
    private var hudView: some View {
        HStack(spacing: 10) {
            switch coordinator.hudState {
            case .importing:
                ProgressView()
                    .tint(.white)
                Text(String(localized: "Importing…"))
                    .foregroundStyle(.white)
            case .success(let name):
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                Text(String(localized: "\(name) imported"))
                    .foregroundStyle(.white)
                    .lineLimit(1)
            case .error(let msg):
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.red)
                Text(msg)
                    .foregroundStyle(.white)
                    .lineLimit(2)
            case .hint(let msg):
                Image(systemName: "info.circle.fill")
                    .foregroundStyle(.blue)
                Text(msg)
                    .foregroundStyle(.white)
                    .lineLimit(2)
            case .hidden:
                EmptyView()
            }
        }
        .font(.subheadline.weight(.medium))
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.black.opacity(0.75), in: Capsule())
    }
}

// MARK: - Skill Browser Coordinator

@MainActor
private class SkillBrowserCoordinator: ObservableObject {
    enum HUDState: Equatable {
        case hidden, importing, success(String), error(String), hint(String)
    }

    @Published var currentURL: URL?
    @Published var hudState: HUDState = .hidden
    @Published var showOverwriteConfirm = false
    var pendingImportURL: String = ""
    var pendingImportContent: String = ""
    var pendingOverwriteName: String = ""

    func updateURL(_ url: URL?) {
        currentURL = url
    }

    private func isSkillDirectoryURL(_ url: URL) -> Bool {
        let s = url.absoluteString
        guard s.contains("github.com") else { return true } // Non-GitHub, let it try
        if s.hasSuffix("SKILL.md") { return true }
        // Must contain /tree/ or /blob/ with a path after the branch name
        let pattern = #"github\.com/[^/]+/[^/]+/(tree|blob)/[^/]+/.+"#
        if s.range(of: pattern, options: .regularExpression) != nil { return true }
        // Reject known non-skill pages
        let nonSkill = ["/issues", "/pulls", "/pull/", "/actions", "/settings", "/wiki"]
        if nonSkill.contains(where: { s.contains($0) }) { return false }
        return false
    }

    func importCurrentSkill() {
        guard let url = currentURL else { return }
        let urlString = url.absoluteString

        // Check if URL points to a specific skill directory
        if !isSkillDirectoryURL(url) {
            hudState = .hint(String(localized: "Select a skill folder first"))
            Task {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if case .hint = hudState { hudState = .hidden }
            }
            return
        }

        hudState = .importing

        Task {
            do {
                // Download and parse first to get the real skill name
                let preflight = try await SkillStore.shared.preflightGitHubImport(urlString: urlString)

                // Check if skill already exists
                if SkillStore.shared.skills.contains(where: { $0.id == preflight.id }) {
                    hudState = .hidden
                    pendingImportURL = urlString
                    pendingImportContent = preflight.content
                    pendingOverwriteName = preflight.name
                    showOverwriteConfirm = true
                    return
                }

                // No conflict — import directly
                let skill = try await SkillStore.shared.commitGitHubImport(urlString: urlString, content: preflight.content)
                hudState = .success(skill.name)
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if case .success = hudState { hudState = .hidden }
            } catch {
                hudState = .error(error.localizedDescription)
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if case .error = hudState { hudState = .hidden }
            }
        }
    }

    func confirmOverwrite() {
        hudState = .importing
        Task {
            do {
                let skill = try await SkillStore.shared.commitGitHubImport(urlString: pendingImportURL, content: pendingImportContent)
                hudState = .success(skill.name)
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if case .success = hudState { hudState = .hidden }
            } catch {
                hudState = .error(error.localizedDescription)
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                if case .error = hudState { hudState = .hidden }
            }
        }
    }
}

// MARK: - WKWebView Wrapper

private struct SkillBrowserWebView: UIViewRepresentable {
    let coordinator: SkillBrowserCoordinator

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // Use mobile UA so GitHub serves mobile-friendly pages with standard URL routing
        config.applicationNameForUserAgent = "LeoPhoneAgent Mobile Safari"
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.customUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        webView.allowsBackForwardNavigationGestures = true
        // KVO to track URL changes (GitHub SPA uses pushState)
        context.coordinator.observe(webView)
        if let url = URL(string: "https://github.com/leoyb1010/LeoPhoneAgent/tree/main/skills") {
            webView.load(URLRequest(url: url))
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> WebViewDelegate {
        WebViewDelegate(coordinator: coordinator)
    }

    class WebViewDelegate: NSObject {
        let coordinator: SkillBrowserCoordinator
        private var urlObservation: NSKeyValueObservation?

        init(coordinator: SkillBrowserCoordinator) {
            self.coordinator = coordinator
        }

        func observe(_ webView: WKWebView) {
            urlObservation = webView.observe(\.url, options: [.new]) { [weak self] wv, _ in
                Task { @MainActor in
                    self?.coordinator.updateURL(wv.url)
                }
            }
        }
    }
}

// MARK: - File Activity Item Source

/// Vends a local file (e.g. an exported skill `.zip`) to the share sheet with
/// its concrete file URL **and** UTI declared up front.
///
/// Passing a bare `URL` to `UIActivityViewController` makes "Save to Files" on
/// iPad try to fetch the file through a file-provider domain — which fails for
/// an app-`tmp/` URL (`error fetching file provider domain … (null)`), and the
/// archive UTI isn't handled by the pasteboard fallback (`CopyToPasteboard:
/// Not handling archive UTI`), so the picker saved an empty file. Declaring the
/// item as a file with `dataTypeIdentifierForActivityType` = the file's UTI
/// (`public.zip`) lets the document picker copy the real bytes to the chosen
/// destination. [T-ios-ipad-skill-export-file-empty-save]
private final class FileActivityItemSource: NSObject, UIActivityItemSource {
    private let fileURL: URL
    private let typeIdentifier: String

    init(fileURL: URL) {
        self.fileURL = fileURL
        // Resolve a concrete UTI from the extension; fall back to public.zip
        // (skill exports are always zip archives) then public.data.
        let ext = fileURL.pathExtension
        let resolved = UTType(filenameExtension: ext)
            ?? (ext.lowercased() == "skill" ? UTType.zip : nil)
            ?? UTType.zip
        self.typeIdentifier = resolved.identifier
        super.init()
    }

    func activityViewControllerPlaceholderItem(_ controller: UIActivityViewController) -> Any {
        fileURL
    }

    func activityViewController(_ controller: UIActivityViewController,
                                itemForActivityType activityType: UIActivity.ActivityType?) -> Any? {
        fileURL
    }

    func activityViewController(_ controller: UIActivityViewController,
                                dataTypeIdentifierForActivityType activityType: UIActivity.ActivityType?) -> String {
        typeIdentifier
    }

    func activityViewController(_ controller: UIActivityViewController,
                                subjectForActivityType activityType: UIActivity.ActivityType?) -> String {
        fileURL.lastPathComponent
    }
}

// MARK: - Activity View (UIActivityViewController wrapper)

private struct ActivityView: UIViewControllerRepresentable {
    let activityItems: [Any]
    var onDismiss: (() -> Void)?

    func makeUIViewController(context: Context) -> UIActivityViewController {
        // Wrap file URLs in a FileActivityItemSource so "Save to Files" gets a
        // declared UTI and copies the real bytes (fixes empty saves on iPad).
        let items: [Any] = activityItems.map { item in
            if let url = item as? URL, url.isFileURL {
                return FileActivityItemSource(fileURL: url)
            }
            return item
        }
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        controller.completionWithItemsHandler = { _, _, _, _ in
            onDismiss?()
        }
        return controller
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// MARK: - Recommended skills catalog [T-skill-catalog]

/// One entry in the built-in recommended skills directory. Entries with a
/// `skillURL` point at a real SKILL.md on GitHub (verified 2026-07) and
/// install through the existing `SkillStore.importFromGitHub` path, sibling
/// files included. Entries without one are platform-gated services whose
/// docs open in Safari instead.
private struct SkillCatalogEntry: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let skillURL: String?
    let docsURL: String

    /// [T-skill-marketplace] Community skill indexes. Our SKILL.md parser
    /// reads the same `name` / `description` / `version` YAML frontmatter as
    /// the Agent Skills open standard (SkillStore.parseFrontmatter), so
    /// skills published for Claude Code / Codex / Cursor install here
    /// unchanged through the existing GitHub import path.
    ///
    /// Deliberately links to the INDEX rather than mirroring thousands of
    /// entries: the lists change daily, and most of them assume a desktop
    /// coding environment. The footer says so instead of pretending
    /// everything is phone-appropriate.
    struct Marketplace: Identifiable {
        let id: String
        let title: String
        let subtitle: String
        let url: String
    }

    static let marketplaces: [Marketplace] = [
        Marketplace(
            id: "voltagent",
            title: "Awesome Agent Skills",
            subtitle: "1497+ 个技能，含 Anthropic / Google / Vercel / Stripe / Cloudflare 官方出品",
            url: "https://github.com/VoltAgent/awesome-agent-skills"
        ),
        Marketplace(
            id: "travisvn",
            title: "Awesome Claude Skills",
            subtitle: "偏工作流与自动化的精选清单",
            url: "https://github.com/travisvn/awesome-claude-skills"
        ),
        Marketplace(
            id: "marketplace",
            title: "Skill Marketplace",
            subtitle: "首个专为 agent skills 建的开源市场，可按领域检索",
            url: "https://github.com/dukelyuu/skills-marketplace"
        ),
        Marketplace(
            id: "anthropic",
            title: "Anthropic 官方技能库",
            subtitle: "文档处理（docx / pdf / xlsx / pptx）等一等公民技能",
            url: "https://github.com/anthropics/skills"
        ),
    ]

    static let all: [SkillCatalogEntry] = [
        // Phone-appropriate picks from the marketplaces above. These are
        // vetted to not assume a desktop checkout or a long-lived daemon.
        SkillCatalogEntry(
            id: "anthropic-docx",
            title: "Word 文档处理",
            subtitle: "读写 .docx：生成报告、批注、查找替换（Anthropic 官方）",
            skillURL: "https://github.com/anthropics/skills/blob/main/skills/docx/SKILL.md",
            docsURL: "https://github.com/anthropics/skills"
        ),
        SkillCatalogEntry(
            id: "anthropic-pdf",
            title: "PDF 处理",
            subtitle: "合并、拆分、提取文本与表格、填表单（Anthropic 官方）",
            skillURL: "https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md",
            docsURL: "https://github.com/anthropics/skills"
        ),
        SkillCatalogEntry(
            id: "anthropic-xlsx",
            title: "表格处理",
            subtitle: "读写 .xlsx / .csv：清洗、公式、图表（Anthropic 官方）",
            skillURL: "https://github.com/anthropics/skills/blob/main/skills/xlsx/SKILL.md",
            docsURL: "https://github.com/anthropics/skills"
        ),
        SkillCatalogEntry(
            id: "anthropic-pptx",
            title: "幻灯片处理",
            subtitle: "生成与编辑 .pptx 演示文稿（Anthropic 官方）",
            skillURL: "https://github.com/anthropics/skills/blob/main/skills/pptx/SKILL.md",
            docsURL: "https://github.com/anthropics/skills"
        ),
        SkillCatalogEntry(
            id: "anthropic-doc-coauthoring",
            title: "文档协作写作",
            subtitle: "与你一起起草、改写、评审长文档（Anthropic 官方）",
            skillURL: "https://github.com/anthropics/skills/blob/main/skills/doc-coauthoring/SKILL.md",
            docsURL: "https://github.com/anthropics/skills"
        ),
        SkillCatalogEntry(
            id: "anthropic-skill-creator",
            title: "技能创作器",
            subtitle: "让 Agent 帮你写新的 SKILL.md（Anthropic 官方）",
            skillURL: "https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md",
            docsURL: "https://github.com/anthropics/skills"
        ),
        SkillCatalogEntry(
            id: "anthropic-mcp-builder",
            title: "MCP 构建助手",
            subtitle: "协助编写和调试 MCP 服务器（Anthropic 官方）",
            skillURL: "https://github.com/anthropics/skills/blob/main/skills/mcp-builder/SKILL.md",
            docsURL: "https://github.com/anthropics/skills"
        ),
        SkillCatalogEntry(
            id: "wechatpay",
            title: "微信支付",
            subtitle: "AI 接入微信支付：下单、商品券发券/核销/查询、代码安全检查",
            skillURL: "https://github.com/wechatpay-apiv3/wechatpay-skills/blob/main/wechatpay-payment-integration/SKILL.md",
            docsURL: "https://github.com/wechatpay-apiv3/wechatpay-skills"
        ),
        SkillCatalogEntry(
            id: "netease-music",
            title: "网易云音乐助手",
            subtitle: "搜索、播放、歌单管理、红心歌单偏好画像",
            skillURL: "https://github.com/NetEase/skills/blob/master/netease-music-assistant/SKILL.md",
            docsURL: "https://github.com/NetEase/skills"
        ),
        SkillCatalogEntry(
            id: "mt-paotui",
            title: "美团跑腿",
            subtitle: "跑腿下单、地址簿匹配、订单预览",
            skillURL: "https://github.com/meituan/MT-Paotui-For-Client/blob/main/SKILL.md",
            docsURL: "https://github.com/meituan/MT-Paotui-For-Client"
        ),
        SkillCatalogEntry(
            id: "luckin",
            title: "瑞幸咖啡",
            subtitle: "AI 点咖啡、查门店、搜商品、到店自取（开放平台接入）",
            skillURL: nil,
            docsURL: "https://open.lkcoffee.com"
        ),
        SkillCatalogEntry(
            id: "weread",
            title: "微信读书",
            subtitle: "书架、阅读进度、笔记检索、书籍搜索（官方 Skill）",
            skillURL: nil,
            docsURL: "https://weread.qq.com/r/weread-skills"
        ),
        SkillCatalogEntry(
            id: "meitu",
            title: "美图",
            subtitle: "图片编辑、文生图、AI 写真、背景替换（开放平台接入）",
            skillURL: nil,
            docsURL: "https://www.miraclevision.com/open-claw"
        ),
        SkillCatalogEntry(
            id: "fliggy",
            title: "飞猪",
            subtitle: "机票/酒店/门票咨询、规划、预定（开放平台接入）",
            skillURL: nil,
            docsURL: "https://flyai.open.fliggy.com/"
        ),
    ]
}

private struct SkillCatalogSheet: View {
    @Environment(\.dismiss) private var dismiss

    private enum InstallState: Equatable {
        case idle
        case installing
        case installed(name: String)
        case failed(String)
    }

    @State private var states: [String: InstallState] = [:]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(SkillCatalogEntry.all.filter { $0.skillURL != nil }) { entry in
                        installableRow(entry)
                    }
                } header: {
                    Text("可直接安装")
                } footer: {
                    Text("从官方 GitHub 仓库安装 SKILL.md 及配套文件。技能的密钥/账号配置见安装后的技能详情。")
                }

                Section {
                    ForEach(SkillCatalogEntry.all.filter { $0.skillURL == nil }) { entry in
                        Button {
                            if let url = URL(string: entry.docsURL) {
                                UIApplication.shared.open(url)
                            }
                        } label: {
                            row(entry, trailing: {
                                Image(systemName: "arrow.up.right.square")
                                    .foregroundStyle(Color.secondary)
                            })
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    Text("平台接入型（查看文档）")
                }

                // [T-skill-marketplace] Index links, not a mirror — these
                // lists change daily and most entries assume a desktop
                // coding environment.
                Section {
                    ForEach(SkillCatalogEntry.marketplaces) { market in
                        Button {
                            if let url = URL(string: market.url) {
                                UIApplication.shared.open(url)
                            }
                        } label: {
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(market.title)
                                        .font(.body)
                                        .foregroundStyle(.primary)
                                    Text(market.subtitle)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                }
                                Spacer(minLength: 8)
                                Image(systemName: "arrow.up.right.square")
                                    .foregroundStyle(Color.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    Text("技能市场")
                } footer: {
                    Text("这些库使用与本应用相同的 SKILL.md 标准（name / description 前置元数据），可直接安装。在市场里找到想要的技能后，复制它的 SKILL.md 链接，用「导入技能」粘贴即可。注意：市场里多数技能面向桌面编码场景，手机上未必适用。")
                }
            }
            .navigationTitle("推荐 Skill")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(String(localized: "Done")) { dismiss() }
                }
            }
        }
    }

    @ViewBuilder
    private func installableRow(_ entry: SkillCatalogEntry) -> some View {
        let state = states[entry.id] ?? .idle
        VStack(alignment: .leading, spacing: 6) {
            row(entry, trailing: {
                switch state {
                case .idle:
                    Button("安装") { install(entry) }
                        .buttonStyle(.glass)
                        .controlSize(.small)
                case .installing:
                    ProgressView()
                case .installed:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Color.green)
                case .failed:
                    Button("重试") { install(entry) }
                        .buttonStyle(.glass)
                        .controlSize(.small)
                        .tint(.orange)
                }
            })
            if case .failed(let message) = state {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(3)
            }
            if case .installed(let name) = state {
                Text("已安装为「\(name)」，可在 Skills 列表中启用/停用。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func row(_ entry: SkillCatalogEntry, @ViewBuilder trailing: () -> some View) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title)
                    .font(.body)
                    .foregroundStyle(.primary)
                Text(entry.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            trailing()
        }
    }

    private func install(_ entry: SkillCatalogEntry) {
        guard let skillURL = entry.skillURL else { return }
        states[entry.id] = .installing
        Task {
            do {
                let skill = try await SkillStore.shared.importFromGitHub(urlString: skillURL)
                states[entry.id] = .installed(name: skill.name)
            } catch {
                states[entry.id] = .failed(error.localizedDescription)
            }
        }
    }
}
