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

    /// Actions the host wires: open session / run quick task / open surface.
    let openSession: (String) -> Void
    let runQuickTask: (String) -> Void
    let openSurface: (String) -> Void   // "automations" | "remoteHosts" | "timeline" | "artifacts" | "scheduled"
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
        for session in WidgetRecentSessionsStore.load().prefix(12) {
            all.append(Item(id: "s-" + session.id, title: session.title,
                            subtitle: String(localized: "Session"), symbol: "bubble.left.and.bubble.right") {
                openSession(session.id)
            })
        }
        for task in QuickTaskStore.shared.tasks {
            all.append(Item(id: "q-" + task.id, title: task.displayName,
                            subtitle: String(localized: "Quick task"), symbol: task.symbolName) {
                runQuickTask(task.id)
            })
        }
        let surfaces: [(String, String, String)] = [
            ("automations", String(localized: "Automations"), "bolt.badge.clock"),
            ("remoteHosts", String(localized: "Remote Hosts"), "server.rack"),
            ("timeline", String(localized: "Agent Timeline"), "list.bullet.rectangle.portrait"),
            ("scheduled", String(localized: "Scheduled Tasks"), "clock.badge.checkmark"),
        ]
        for (key, title, symbol) in surfaces {
            all.append(Item(id: "p-" + key, title: title,
                            subtitle: String(localized: "Open"), symbol: symbol) {
                openSurface(key)
            })
        }
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
                    Button(String(localized: "Cancel")) { close() }
                        .keyboardShortcut(.cancelAction)   // Esc; iPadOS 26 doesn't bind it for sheets
                }
            }
        }
    }
}
