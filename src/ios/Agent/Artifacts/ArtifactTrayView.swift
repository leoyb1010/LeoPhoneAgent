import QuickLook
import SwiftUI

@MainActor
final class ArtifactTrayViewModel: ObservableObject {
    enum LoadState: Equatable {
        case loading
        case loaded
        case failed(String)
    }

    @Published private(set) var artifacts: [ArtifactSnapshot] = []
    @Published private(set) var state: LoadState = .loading
    @Published var showsTrash = false
    @Published private(set) var savedToTreasury: Set<String> = []

    private let repository: ArtifactRepository
    private let sessionId: String?

    init(sessionId: String?, repository: ArtifactRepository = .shared) {
        self.sessionId = sessionId
        self.repository = repository
    }

    func load() async {
        if artifacts.isEmpty { state = .loading }
        do {
            artifacts = try await repository.list(
                sessionId: sessionId,
                includeTrashed: showsTrash
            ).filter { showsTrash ? $0.artifact.isTrashed : !$0.artifact.isTrashed }
            state = .loaded
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func fileURL(for snapshot: ArtifactSnapshot) async throws -> URL {
        guard let version = snapshot.currentVersion else {
            throw ArtifactRepository.RepositoryError.artifactNotFound
        }
        return try await repository.fileURL(for: version)
    }

    func moveToTrash(_ snapshot: ArtifactSnapshot) async {
        do {
            try await repository.trash(id: snapshot.artifact.id)
            await load()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func restore(_ snapshot: ArtifactSnapshot) async {
        do {
            try await repository.restore(id: snapshot.artifact.id)
            await load()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func purge(_ snapshot: ArtifactSnapshot) async {
        do {
            try await repository.purge(id: snapshot.artifact.id)
            await load()
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    func saveToTreasury(_ snapshot: ArtifactSnapshot) async throws {
        guard let version = snapshot.currentVersion else {
            throw ArtifactRepository.RepositoryError.artifactNotFound
        }
        let url = try await repository.fileURL(for: version)
        guard var item = await AttachmentImporter.importFile(at: url) else {
            throw CocoaError(.fileWriteUnknown)
        }
        item.title = snapshot.artifact.title
        item.sourceLabel = "Artifact"
        item.summary = "来自会话 Artifact · \(snapshot.artifact.kind.rawValue)"
        CollectionStore.add([item])
        savedToTreasury.insert(snapshot.artifact.id)
    }
}

struct ArtifactTrayView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var viewModel: ArtifactTrayViewModel
    @State private var previewURL: URL?
    @State private var shareURL: URL?
    @State private var versionHistory: ArtifactSnapshot?
    @State private var pendingPurge: ArtifactSnapshot?
    @State private var actionError: String?

    init(sessionId: String?) {
        _viewModel = StateObject(wrappedValue: ArtifactTrayViewModel(sessionId: sessionId))
    }

    var body: some View {
        NavigationStack {
            Group {
                switch viewModel.state {
                case .loading where viewModel.artifacts.isEmpty:
                    loadingState
                case .failed(let message) where viewModel.artifacts.isEmpty:
                    errorState(message)
                default:
                    artifactList
                }
            }
            .navigationTitle(String(localized: "Artifacts"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(viewModel.showsTrash ? String(localized: "Artifacts") : String(localized: "Trash")) {
                        viewModel.showsTrash.toggle()
                        Task { await viewModel.load() }
                    }
                    .accessibilityHint(viewModel.showsTrash
                        ? String(localized: "Shows active artifacts")
                        : String(localized: "Shows deleted artifacts"))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(String(localized: "Done")) { dismiss() }
                }
            }
            .refreshable { await viewModel.load() }
            .task { await viewModel.load() }
            .sheet(item: $previewURL) { url in
                ArtifactQuickLookPreview(url: url)
                    .ignoresSafeArea()
            }
            .sheet(item: $shareURL) { url in
                MinisShareSheet(url: url)
            }
            .sheet(item: $versionHistory) { snapshot in
                ArtifactVersionHistoryView(snapshot: snapshot)
            }
            .alert(String(localized: "Delete Permanently?"), isPresented: Binding(
                get: { pendingPurge != nil },
                set: { if !$0 { pendingPurge = nil } }
            )) {
                Button(String(localized: "Delete Permanently"), role: .destructive) {
                    guard let item = pendingPurge else { return }
                    pendingPurge = nil
                    Task { await viewModel.purge(item) }
                }
                Button(String(localized: "Cancel"), role: .cancel) { pendingPurge = nil }
            } message: {
                Text(String(localized: "This removes the artifact and every local version. This action cannot be undone."))
            }
            .alert(String(localized: "Unable to Open Artifact"), isPresented: Binding(
                get: { actionError != nil },
                set: { if !$0 { actionError = nil } }
            )) {
                Button(String(localized: "OK"), role: .cancel) { actionError = nil }
            } message: {
                Text(actionError ?? "")
            }
        }
    }

    private var artifactList: some View {
        List {
            if viewModel.artifacts.isEmpty {
                ArtifactEmptyState(showsTrash: viewModel.showsTrash)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            } else {
                Section {
                    ForEach(viewModel.artifacts, id: \.artifact.id) { snapshot in
                        ArtifactRow(snapshot: snapshot)
                            .contentShape(Rectangle())
                            .onTapGesture { open(snapshot, sharing: false) }
                            .contextMenu { actions(for: snapshot) }
                            .swipeActions(edge: .trailing, allowsFullSwipe: !viewModel.showsTrash) {
                                if viewModel.showsTrash {
                                    Button(role: .destructive) { pendingPurge = snapshot } label: {
                                        Label(String(localized: "Delete"), systemImage: "trash")
                                    }
                                } else {
                                    Button(role: .destructive) {
                                        Task { await viewModel.moveToTrash(snapshot) }
                                    } label: {
                                        Label(String(localized: "Trash"), systemImage: "trash")
                                    }
                                }
                            }
                            .swipeActions(edge: .leading, allowsFullSwipe: true) {
                                if viewModel.showsTrash {
                                    Button {
                                        Task { await viewModel.restore(snapshot) }
                                    } label: {
                                        Label(String(localized: "Restore"), systemImage: "arrow.uturn.backward")
                                    }
                                    .tint(.blue)
                                } else {
                                    Button {
                                        Task {
                                            do {
                                                try await viewModel.saveToTreasury(snapshot)
                                            } catch {
                                                actionError = error.localizedDescription
                                            }
                                        }
                                    } label: {
                                        Label(String(localized: "Save to Treasury"), systemImage: "archivebox")
                                    }
                                    .tint(.orange)
                                    .disabled(viewModel.savedToTreasury.contains(snapshot.artifact.id))
                                    Button { open(snapshot, sharing: true) } label: {
                                        Label(String(localized: "Share"), systemImage: "square.and.arrow.up")
                                    }
                                    .tint(.blue)
                                }
                            }
                    }
                } footer: {
                    Text(viewModel.showsTrash
                        ? String(localized: "Deleted artifacts remain on this device until you remove them permanently.")
                        : String(localized: "Tap an artifact for Quick Look. Swipe to share or move it to Trash."))
                }
            }
        }
        .listStyle(.insetGrouped)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: viewModel.artifacts)
    }

    @ViewBuilder
    private func actions(for snapshot: ArtifactSnapshot) -> some View {
        Button { versionHistory = snapshot } label: {
            Label(String(localized: "Version History"), systemImage: "clock.arrow.circlepath")
        }
        if viewModel.showsTrash {
            Button {
                Task { await viewModel.restore(snapshot) }
            } label: {
                Label(String(localized: "Restore"), systemImage: "arrow.uturn.backward")
            }
            Button(role: .destructive) { pendingPurge = snapshot } label: {
                Label(String(localized: "Delete Permanently"), systemImage: "trash")
            }
        } else {
            Button {
                Task {
                    do {
                        try await viewModel.saveToTreasury(snapshot)
                    } catch {
                        actionError = error.localizedDescription
                    }
                }
            } label: {
                Label(
                    viewModel.savedToTreasury.contains(snapshot.artifact.id)
                        ? String(localized: "Saved to Treasury")
                        : String(localized: "Save to Treasury"),
                    systemImage: viewModel.savedToTreasury.contains(snapshot.artifact.id)
                        ? "checkmark.circle" : "archivebox"
                )
            }
            .disabled(viewModel.savedToTreasury.contains(snapshot.artifact.id))
            Button { open(snapshot, sharing: false) } label: {
                Label(String(localized: "Quick Look"), systemImage: "eye")
            }
            Button { open(snapshot, sharing: true) } label: {
                Label(String(localized: "Share"), systemImage: "square.and.arrow.up")
            }
            Button(role: .destructive) {
                Task { await viewModel.moveToTrash(snapshot) }
            } label: {
                Label(String(localized: "Move to Trash"), systemImage: "trash")
            }
        }
    }

    private func open(_ snapshot: ArtifactSnapshot, sharing: Bool) {
        Task {
            do {
                let url = try await viewModel.fileURL(for: snapshot)
                guard FileManager.default.fileExists(atPath: url.path) else {
                    throw CocoaError(.fileNoSuchFile)
                }
                if sharing { shareURL = url } else { previewURL = url }
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    private var loadingState: some View {
        VStack(spacing: 14) {
            ProgressView()
            Text(String(localized: "Loading Artifacts"))
                .font(.headline)
            Text(String(localized: "Reading the local artifact index."))
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(.orange)
            Text(String(localized: "Artifacts Unavailable"))
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(String(localized: "Try Again")) {
                Task { await viewModel.load() }
            }
            .buttonStyle(.glassProminent)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct ArtifactVersionHistoryView: View {
    @Environment(\.dismiss) private var dismiss
    let snapshot: ArtifactSnapshot

    @State private var versions: [ArtifactVersion] = []
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var previewURL: URL?
    @State private var shareURL: URL?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView(String(localized: "Loading Versions"))
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 34, weight: .regular))
                            .foregroundStyle(.orange)
                        Text(String(localized: "Versions Unavailable"))
                            .font(.headline)
                        Text(errorMessage)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(32)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    versionList
                }
            }
            .navigationTitle(snapshot.artifact.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(String(localized: "Done")) { dismiss() }
                }
            }
            .task { await load() }
            .sheet(item: $previewURL) { url in
                ArtifactQuickLookPreview(url: url).ignoresSafeArea()
            }
            .sheet(item: $shareURL) { url in
                MinisShareSheet(url: url)
            }
        }
    }

    private var versionList: some View {
        List {
            if let sourcePath = snapshot.artifact.sourcePath {
                Section {
                    Label {
                        Text(sourcePath)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                    } icon: {
                        Image(systemName: "folder")
                    }
                } header: {
                    Text(String(localized: "Source"))
                } footer: {
                    Text(String(localized: "The original workspace file remains unchanged when an artifact is deleted."))
                }
            }

            Section {
                ForEach(versions) { version in
                    Button { open(version, sharing: false) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "doc")
                                .foregroundStyle(.secondary)
                                .accessibilityHidden(true)
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text("Version \(version.versionNumber)")
                                        .font(.body.weight(.medium))
                                    if version.id == snapshot.artifact.currentVersionId {
                                        Text(String(localized: "Current"))
                                            .font(.caption2.weight(.semibold))
                                            .foregroundStyle(.blue)
                                    }
                                }
                                Text(version.createdAt, format: .dateTime.year().month().day().hour().minute())
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(ByteCountFormatter.string(fromByteCount: version.byteCount, countStyle: .file))
                                    .font(.caption2.monospacedDigit())
                                    .foregroundStyle(.tertiary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                                .accessibilityHidden(true)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button { open(version, sharing: false) } label: {
                            Label(String(localized: "Quick Look"), systemImage: "eye")
                        }
                        Button { open(version, sharing: true) } label: {
                            Label(String(localized: "Share"), systemImage: "square.and.arrow.up")
                        }
                    }
                    .accessibilityHint(String(localized: "Opens this version in Quick Look"))
                }
            } header: {
                Text(String(localized: "Versions"))
            }
        }
        .listStyle(.insetGrouped)
    }

    private func load() async {
        do {
            versions = try await ArtifactRepository.shared.versions(artifactId: snapshot.artifact.id)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func open(_ version: ArtifactVersion, sharing: Bool) {
        Task {
            do {
                let url = try await ArtifactRepository.shared.fileURL(for: version)
                guard FileManager.default.fileExists(atPath: url.path) else {
                    throw CocoaError(.fileNoSuchFile)
                }
                if sharing { shareURL = url } else { previewURL = url }
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

private struct ArtifactRow: View {
    let snapshot: ArtifactSnapshot

    var body: some View {
        HStack(spacing: 13) {
            Image(systemName: snapshot.artifact.kind.symbolName)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(snapshot.artifact.kind.tint)
                .frame(width: 38, height: 38)
                .background(snapshot.artifact.kind.tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(snapshot.artifact.title)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                if let version = snapshot.currentVersion {
                    Text(version.originalFileName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text("Version \(version.versionNumber)  \(ByteCountFormatter.string(fromByteCount: version.byteCount, countStyle: .file))")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 8)
            Text(snapshot.artifact.updatedAt, format: .relative(presentation: .named))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityHint(String(localized: "Opens Quick Look"))
    }
}

private struct ArtifactEmptyState: View {
    let showsTrash: Bool

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: showsTrash ? "trash" : "shippingbox")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(.secondary)
            Text(showsTrash ? String(localized: "Trash Is Empty") : String(localized: "No Artifacts Yet"))
                .font(.headline)
            Text(showsTrash
                ? String(localized: "Artifacts moved to Trash will appear here.")
                : String(localized: "Documents, media, and code created by tasks will appear here."))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.vertical, 56)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }
}

private struct ArtifactQuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        guard context.coordinator.url != url else { return }
        context.coordinator.url = url
        controller.reloadData()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL

        init(url: URL) { self.url = url }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}

private extension ArtifactKind {
    var symbolName: String {
        switch self {
        case .document: return "doc.text"
        case .image: return "photo"
        case .audio: return "waveform"
        case .video: return "play.rectangle"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .archive: return "archivebox"
        case .file: return "doc"
        }
    }

    var tint: Color {
        switch self {
        case .document: return .blue
        case .image: return .purple
        case .audio: return .orange
        case .video: return .pink
        case .code: return .green
        case .archive: return .brown
        case .file: return .gray
        }
    }
}
