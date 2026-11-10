import SwiftUI

/// A reading-position request belongs to this particular chat view model, not a global active session.
struct ChatSearchScrollRequest: Equatable {
    let id = UUID()
    let owner: ObjectIdentifier
    let messageID: UUID
}

/// Search only the text already loaded for this chat. It does not query other sessions or modify chat storage.
struct ChatConversationSearch: View {
    @ObservedObject var vm: AIChatViewModel
    let onSelect: (UUID) -> Void
    @ObservedObject private var locks = SessionLockStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var matches: [Match] = []
    @State private var searching = false
    @State private var generation = 0

    private struct Entry: Sendable {
        let id: UUID
        let isUser: Bool
        let text: String
    }

    private struct Match: Identifiable, Sendable {
        let id: UUID
        let isUser: Bool
        let excerpt: String
    }

    private struct SearchKey: Hashable, Sendable {
        let query: String
        let owner: ObjectIdentifier
        let messageCount: Int
        let processing: Bool
        let locked: Bool
    }

    private var locked: Bool {
        vm.sessionId.map { locks.isVisuallyLocked($0) } ?? false
    }

    private var key: SearchKey {
        SearchKey(query: query.trimmingCharacters(in: .whitespacesAndNewlines), owner: ObjectIdentifier(vm),
                  messageCount: vm.messages.count, processing: vm.isProcessing, locked: locked)
    }

    var body: some View {
        NavigationStack {
            Group {
                if locked {
                    ContentUnavailableView("对话已锁定", systemImage: "lock", description: Text("解锁对话后再查找内容。"))
                } else if key.query.isEmpty {
                    ContentUnavailableView("查找对话内容", systemImage: "magnifyingglass",
                                           description: Text("输入关键词，查找当前已加载的文字消息。"))
                } else if searching {
                    ProgressView("正在查找…")
                } else if matches.isEmpty {
                    ContentUnavailableView.search(text: query)
                } else {
                    List {
                        Section(String(format: AppLocalized("找到 %d 条消息"), matches.count)) {
                            ForEach(matches) { match in
                                Button {
                                    guard !locked, vm.messages.contains(where: { $0.id == match.id }) else { return }
                                    onSelect(match.id)
                                    dismiss()
                                } label: {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(match.isUser ? AppLocalized("你") : "LeoBot")
                                            .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                        Text(match.excerpt).font(.body).foregroundStyle(.primary).lineLimit(4)
                                    }
                                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            .navigationTitle("查找对话内容")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: AppLocalized("查找当前对话"))
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
            .task(id: key) { await search(key) }
        }
    }

    @MainActor private func search(_ request: SearchKey) async {
        guard !Task.isCancelled else { return }
        generation &+= 1
        let currentGeneration = generation
        matches = []
        searching = !request.query.isEmpty && !request.locked
        defer { if generation == currentGeneration { searching = false } }
        guard searching else { return }
        do { try await Task.sleep(nanoseconds: 200_000_000) } catch { return }
        guard !Task.isCancelled, request == key else { return }
        let entries = vm.messages.compactMap { message -> Entry? in
            guard message.role == .user || message.role == .assistant else { return nil }
            let text: String
            if message.role == .assistant, !message.blocks.isEmpty {
                text = message.blocks.filter { if case .text = $0.kind { return true }; return false }
                    .map(\.content).joined(separator: "\n\n")
            } else {
                text = message.content
            }
            guard !text.isEmpty else { return nil }
            return Entry(id: message.id, isUser: message.role == .user, text: text)
        }
        let found = await Task.detached(priority: .userInitiated) {
            entries.compactMap { entry -> Match? in
                guard let range = entry.text.range(of: request.query, options: [.caseInsensitive, .diacriticInsensitive]) else { return nil }
                let start = entry.text.index(range.lowerBound, offsetBy: -70, limitedBy: entry.text.startIndex) ?? entry.text.startIndex
                let end = entry.text.index(range.upperBound, offsetBy: 100, limitedBy: entry.text.endIndex) ?? entry.text.endIndex
                let excerpt = (start == entry.text.startIndex ? "" : "…") + String(entry.text[start..<end])
                    + (end == entry.text.endIndex ? "" : "…")
                return Match(id: entry.id, isUser: entry.isUser, excerpt: excerpt)
            }
        }.value
        guard !Task.isCancelled, generation == currentGeneration, request == key, !locked else { return }
        matches = found
    }
}
