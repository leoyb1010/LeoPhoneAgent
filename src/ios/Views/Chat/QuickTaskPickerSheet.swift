//
//  QuickTaskPickerSheet.swift
//  MinisApp
//
//  [T-composer-quicktask-picker] Full quick-task list for the composer. The
//  strip above the input field only has room for the three composer-pinned
//  tasks, which hid the rest of the catalog and offered no way to create one
//  without going to Settings. This sheet lists every task, is searchable, and
//  can both pin and create.
//

import SwiftUI

struct QuickTaskPickerSheet: View {
    /// Called with the chosen task; the caller fills the composer with it.
    let onSelect: (QuickTaskDefinition) -> Void

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = QuickTaskStore.shared
    @State private var query = ""
    @State private var showEditor = false

    private var filtered: [QuickTaskDefinition] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return store.tasks }
        return store.tasks.filter {
            $0.displayName.lowercased().contains(q) || $0.prompt.lowercased().contains(q)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                if filtered.isEmpty {
                    Section {
                        Text(query.isEmpty
                             ? "No quick tasks yet — tap + to create one."
                             : "No tasks match “\(query)”.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section {
                        ForEach(filtered) { task in
                            Button {
                                onSelect(task)
                                dismiss()
                            } label: {
                                row(task)
                            }
                            .buttonStyle(.plain)
                            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                Button {
                                    togglePin(task)
                                } label: {
                                    Label(store.isPinnedToComposer(task.id) ? String(localized: "Unpin") : String(localized: "Pin"),
                                          systemImage: store.isPinnedToComposer(task.id) ? "pin.slash" : "pin")
                                }
                                .tint(.orange)
                            }
                        }
                    } footer: {
                        Text("Tap a task to put its prompt in the message field. Swipe to pin your favourites above the composer (up to \(QuickTaskStore.composerTaskLimit)).")
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: Text("Search quick tasks"))
            .navigationTitle("Quick Tasks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showEditor = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("New quick task")
                }
            }
            .sheet(isPresented: $showEditor) {
                NavigationStack {
                    QuickTaskEditorView(mode: .create)
                }
            }
        }
    }

    private func row(_ task: QuickTaskDefinition) -> some View {
        HStack(spacing: 12) {
            Image(systemName: task.symbolName)
                .font(.body)
                .frame(width: 26)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(task.displayName)
                        .font(.body)
                        .foregroundStyle(.primary)
                    if store.isPinnedToComposer(task.id) {
                        Image(systemName: "pin.fill")
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                    if !task.isBuiltIn {
                        Text("Custom")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.secondary.opacity(0.15), in: Capsule())
                    }
                }
                Text(task.prompt)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .hoverEffect(.highlight)
    }

    private func togglePin(_ task: QuickTaskDefinition) {
        let pinned = store.isPinnedToComposer(task.id)
        store.setComposerPinned(!pinned, id: task.id)
    }
}
