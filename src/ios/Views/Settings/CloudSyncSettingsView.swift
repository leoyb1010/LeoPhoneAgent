import SwiftUI

// V1 CloudSyncSettingsView was unlinked after the 1.23 Settings consolidation.
// Live iCloud UI is CloudSyncSettingsV2View. This file keeps SyncLogView for Logs.

// MARK: - Sync Log Viewer

@available(iOS 17.0, *)
struct SyncLogView: View {
    @ObservedObject private var store = SyncLogStore.shared
    @State private var shareItem: ShareFileItem?

    var body: some View {
        List {
            Section {
                Text("Sync events are recorded as iCloud sync sends and receives data. Up to 1,000 entries are kept.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if store.entries.isEmpty {
                Text("No sync events yet.")
                    .foregroundStyle(.secondary)
                    .font(.callout)
            } else {
                ForEach(store.entries) { entry in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            directionBadge(entry.direction)
                            Text(entry.recordType)
                                .font(.system(.subheadline, weight: .semibold))
                            Spacer()
                            Text(entry.timestamp, format: .dateTime.hour().minute().second())
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        if !entry.summary.isEmpty {
                            Text(entry.summary)
                                .font(.caption)
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                        }
                        Text(formatRecordName(entry.recordName))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                        if let deviceName = entry.deviceName {
                            HStack(spacing: 4) {
                                Image(systemName: "iphone")
                                    .font(.system(size: 9))
                                Text(deviceName)
                            }
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        }
                        if entry.direction == .error {
                            Text(entry.detail)
                                .font(.caption2)
                                .foregroundStyle(.red)
                                .lineLimit(2)
                        } else if entry.direction == .conflict {
                            Text(entry.detail)
                                .font(.caption2)
                                .foregroundStyle(.orange)
                                .lineLimit(2)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .navigationTitle("iCloud Sync Logs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    let report = store.exportSanitizedReport()
                    let tempURL = FileManager.default.temporaryDirectory
                        .appendingPathComponent("minis-sync-diagnostic.txt")
                    try? report.write(to: tempURL, atomically: true, encoding: .utf8)
                    shareItem = ShareFileItem(url: tempURL)
                } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .disabled(store.entries.isEmpty)

                Button("Clear") {
                    store.clear()
                }
                .disabled(store.entries.isEmpty)
            }
        }
        .sheet(item: $shareItem) { item in
            SyncLogShareSheet(url: item.url)
        }
    }

    private func directionBadge(_ direction: SyncLogEntry.Direction) -> some View {
        Group {
            switch direction {
            case .sent:
                Image(systemName: "arrow.up.circle.fill")
                    .foregroundStyle(.blue)
            case .received:
                Image(systemName: "arrow.down.circle.fill")
                    .foregroundStyle(.green)
            case .conflict:
                Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                    .foregroundStyle(.yellow)
            case .error:
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(.red)
            }
        }
        .font(.system(size: 16))
    }

    private func formatRecordName(_ name: String) -> String {
        // "Session:ABC-DEF-123" → "ABC-DEF-123"
        if let idx = name.firstIndex(of: ":") {
            return String(name[name.index(after: idx)...])
        }
        return name
    }
}

// MARK: - Sync Log Share Sheet

private struct ShareFileItem: Identifiable {
    let id = UUID()
    let url: URL
}

@available(iOS 17.0, *)
private struct SyncLogShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        // [T-share-sheet-uti] See MinisShareSheet.sanitizedShareURL.
        let safeURL = MinisShareSheet.sanitizedShareURL(url) ?? url
        return UIActivityViewController(activityItems: [safeURL], applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
