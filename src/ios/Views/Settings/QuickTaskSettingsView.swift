import SwiftUI

struct QuickTaskSettingsView: View {
    @ObservedObject private var store = QuickTaskStore.shared
    @State private var editingTask: QuickTaskDefinition?
    @State private var isAddingTask = false
    @State private var taskPendingDeletion: QuickTaskDefinition?
    @State private var showResetConfirmation = false

    var body: some View {
        List {
            Section {
                ForEach(store.tasks) { task in
                    Button {
                        editingTask = task
                    } label: {
                        QuickTaskRow(task: task)
                    }
                    .buttonStyle(.plain)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if !task.isBuiltIn {
                            Button(role: .destructive) {
                                taskPendingDeletion = task
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
                .onMove(perform: store.move)
            } header: {
                Text("Available in Shortcuts")
            } footer: {
                Text("Changes appear in Siri and Shortcuts. Built-in tasks keep stable identifiers so existing automations continue to work.")
            }

            Section {
                Button("Restore Built-in Tasks") {
                    showResetConfirmation = true
                }
            } footer: {
                Text("Restoring resets the eight built-in names, prompts, icons, and order. Custom tasks are kept.")
            }
        }
        .navigationTitle("Quick Tasks")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                EditButton()
                Button {
                    isAddingTask = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add Quick Task")
            }
        }
        .sheet(item: $editingTask) { task in
            NavigationStack {
                QuickTaskEditorView(mode: .edit(task))
            }
        }
        .sheet(isPresented: $isAddingTask) {
            NavigationStack {
                QuickTaskEditorView(mode: .create)
            }
        }
        .confirmationDialog(
            "Delete Quick Task?",
            isPresented: Binding(
                get: { taskPendingDeletion != nil },
                set: { if !$0 { taskPendingDeletion = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let task = taskPendingDeletion {
                    store.delete(id: task.id)
                }
                taskPendingDeletion = nil
            }
            Button("Cancel", role: .cancel) {
                taskPendingDeletion = nil
            }
        } message: {
            Text("Shortcuts that use this custom task will need another task selected.")
        }
        .confirmationDialog(
            "Restore Built-in Tasks?",
            isPresented: $showResetConfirmation,
            titleVisibility: .visible
        ) {
            Button("Restore", role: .destructive) {
                store.resetBuiltIns()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Your custom tasks will not be deleted.")
        }
    }
}

private struct QuickTaskRow: View {
    let task: QuickTaskDefinition

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: task.symbolName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 30, height: 30)
                .background(task.isBuiltIn ? Color.indigo : Color.blue, in: RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 3) {
                Text(task.name)
                    .font(.body.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(task.prompt)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 3)
    }
}

private struct QuickTaskEditorView: View {
    enum Mode {
        case create
        case edit(QuickTaskDefinition)
    }

    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = QuickTaskStore.shared
    @State private var name: String
    @State private var prompt: String
    @State private var symbolName: String

    private let mode: Mode

    private static let symbols = [
        "bolt.fill", "sparkles", "checkmark.circle.fill", "doc.text.fill",
        "calendar", "clock.fill", "heart.fill", "house.fill",
        "camera.fill", "cloud.sun.fill", "magnifyingglass", "bell.fill",
    ]

    init(mode: Mode) {
        self.mode = mode
        switch mode {
        case .create:
            _name = State(initialValue: "")
            _prompt = State(initialValue: "")
            _symbolName = State(initialValue: "bolt.fill")
        case .edit(let task):
            _name = State(initialValue: task.name)
            _prompt = State(initialValue: task.prompt)
            _symbolName = State(initialValue: task.symbolName)
        }
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        Form {
            Section("Task") {
                TextField("Name", text: $name)
                    .textInputAutocapitalization(.sentences)
                TextField("What should LeoPhoneAgent do?", text: $prompt, axis: .vertical)
                    .lineLimit(4...10)
            }

            Section("Icon") {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 16) {
                    ForEach(Self.symbols, id: \.self) { symbol in
                        Button {
                            symbolName = symbol
                        } label: {
                            Image(systemName: symbol)
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(symbolName == symbol ? .white : .primary)
                                .frame(width: 38, height: 38)
                                .background(
                                    symbolName == symbol ? Color.accentColor : Color.secondary.opacity(0.12),
                                    in: RoundedRectangle(cornerRadius: 10)
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(symbol)
                        .accessibilityAddTraits(symbolName == symbol ? .isSelected : [])
                    }
                }
                .padding(.vertical, 6)
            }
        }
        .navigationTitle(isCreating ? "New Quick Task" : "Edit Quick Task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    save()
                }
                .disabled(!canSave)
            }
        }
    }

    private var isCreating: Bool {
        if case .create = mode { return true }
        return false
    }

    private func save() {
        switch mode {
        case .create:
            _ = store.add(name: name, prompt: prompt, symbolName: symbolName)
        case .edit(var task):
            task.name = name
            task.prompt = prompt
            task.symbolName = symbolName
            store.update(task)
        }
        dismiss()
    }
}
