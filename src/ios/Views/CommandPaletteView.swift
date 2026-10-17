//
//  CommandPaletteView.swift
//  MinisApp
//
//  [T-cmdk] 2.0 pillar 7: the ⌘K palette — fuzzy jump to sessions, run
//  quick tasks, open settings surfaces. One field, keyboard-first, built
//  for iPad + hardware keyboard but perfectly usable by touch.
//

import GameController
import SwiftUI

struct CommandPaletteView: View {
    @State private var query = ""
    @State private var searchActive = false

    /// The real session list (the widget's copy says "会话" for every row
    /// while Task Status Privacy is on). A Face ID–locked conversation comes
    /// without its title.
    let sessions: [(id: String, title: String)]
    /// Actions the host wires: open session / run quick task / open surface.
    let openSession: (String) -> Void
    let runQuickTask: (String) -> Void
    /// [WP-43] Fixed commands offered right now (CommandPaletteCatalog), run by the host.
    let commands: [PaletteCommand]
    let runCommand: (PaletteCommand) -> Void
    /// Closes the sheet. Not `dismiss`: with the search field active that only
    /// ends the search, so a picked row ran but the palette stayed open.
    let close: () -> Void

    private struct Item: Identifiable {
        let id: String
        let title: String
        let subtitle: String
        let symbol: String
        let action: () -> Void
    }

    private var items: [Item] {
        var all: [Item] = []
        for session in sessions.prefix(12) {
            all.append(Item(id: "s-" + session.id, title: session.title,
                            subtitle: AppLocalized("Session"), symbol: "bubble.left.and.bubble.right") {
                openSession(session.id)
            })
        }
        for task in QuickTaskStore.shared.tasks {
            all.append(Item(id: "q-" + task.id, title: task.displayName,
                            subtitle: AppLocalized("Quick task"), symbol: task.symbolName) {
                runQuickTask(task.id)
            })
        }
        // [WP-43] Urgent commands (an approval waiting, a run to stop) lead the list;
        // the rest follow the sessions and quick tasks. Mac 控制台 / Mac 画面 only
        // with Mac 舰队 on (CommandPaletteCatalog decides).
        let urgent: Set<PaletteCommand> = [.approve, .deny, .stopRun]
        let commandItems = commands.map { command in
            Item(id: "c-" + command.rawValue, title: AppLocalized(String.LocalizationValue(command.title)),
                 subtitle: command.shortcut ?? AppLocalized("Command"), symbol: command.symbol) {
                runCommand(command)
            }
        }
        let leading = zip(commands, commandItems).filter { urgent.contains($0.0) }.map(\.1)
        let trailing = zip(commands, commandItems).filter { !urgent.contains($0.0) }.map(\.1)
        all = leading + all + trailing
        guard !query.isEmpty else { return all }
        let lowered = query.lowercased()
        return all.filter { fuzzyMatch($0.title.lowercased(), lowered) }
    }

    /// Subsequence fuzzy match — "mstu" hits "Mac Studio 部署".
    private func fuzzyMatch(_ text: String, _ pattern: String) -> Bool {
        var iterator = text.makeIterator()
        outer: for ch in pattern {
            while let t = iterator.next() { if t == ch { continue outer } }
            return false
        }
        return true
    }

    var body: some View {
        NavigationStack {
            List(items) { item in
                Button {
                    item.action()
                    close()
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: item.symbol)
                            .frame(width: 24)
                            .foregroundStyle(.teal)
                        Text(item.title).foregroundStyle(.primary)
                        Spacer()
                        Text(item.subtitle)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .listStyle(.plain)
            .searchable(text: $query, isPresented: $searchActive,
                        placement: .navigationBarDrawer(displayMode: .always),
                        prompt: Text("Search sessions, tasks, pages…"))
            // ⌘K on a hardware keyboard: type straight away, Return takes the top match.
            // Not on touch — an active, empty search dims the list and the first tap
            // only cancels it. Activating mid-slide-in is unreliable, hence the wait.
            .task {
                guard GCKeyboard.coalesced != nil else { return }
                try? await Task.sleep(for: .milliseconds(450))
                searchActive = true
            }
            .onSubmit(of: .search) {
                guard let first = items.first else { return }
                first.action()
                close()
            }
            .navigationTitle(Text("Command Palette"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(AppLocalized("Cancel")) { close() }
                        .keyboardShortcut(.cancelAction)   // Esc; iPadOS 26 doesn't bind it for sheets
                }
            }
        }
    }
}
