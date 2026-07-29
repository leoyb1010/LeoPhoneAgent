//
//  CapabilitiesView.swift
//  MinisApp
//
//  [T-capabilities-center] One place that answers "what can this thing
//  actually do on my phone, and is it allowed to?".
//
//  The capability metadata (label, actions, example prompt, data destination)
//  already lived in OffloadCommandInfo; the system authorization state comes
//  from CapabilityAuthorizationProbe, which reads status without prompting.
//  Neither touches iSH, so this screen is accurate even with the kernel cold.
//

import SwiftUI

struct CapabilitiesView: View {
    @ObservedObject private var probe = CapabilityAuthorizationProbe.shared
    @ObservedObject private var permissions = OffloadPermissionManager.shared
    @State private var query = ""

    private var grouped: [(category: OffloadCommandCategory, items: [OffloadCommandInfo])] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let all = OffloadPermissionManager.allCommands.filter { info in
            guard !q.isEmpty else { return true }
            return info.displayLabel.lowercased().contains(q)
                || info.name.lowercased().contains(q)
                || info.description.lowercased().contains(q)
        }
        var seen: [OffloadCommandCategory] = []
        for item in all where !seen.contains(item.category) { seen.append(item.category) }
        return seen.map { cat in (cat, all.filter { $0.category == cat }) }
    }

    var body: some View {
        List {
            if grouped.isEmpty {
                Section {
                    Text("No capabilities match “\(query)”.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(grouped, id: \.category) { group in
                Section(categoryTitle(group.category)) {
                    ForEach(group.items, id: \.name) { info in
                        NavigationLink {
                            CapabilityDetailView(info: info)
                        } label: {
                            row(info)
                        }
                    }
                }
            }

            Section {
                Button {
                    if let url = URL(string: UIApplication.openSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Label("Open System Settings to change permissions", systemImage: "gear")
                }
            } footer: {
                Text("This shows the current system authorization and never triggers a permission prompt. “Not asked” means iOS will request it the first time the Agent uses this capability.")
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                    prompt: Text("Search capabilities"))
        .navigationTitle("Capabilities")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { probe.refresh() }
    }

    private func row(_ info: OffloadCommandInfo) -> some View {
        let status = probe.statuses[info.name]
        return HStack(spacing: 12) {
            Image(systemName: info.systemImage)
                .frame(width: 26)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(info.displayLabel)
                    .font(.body)
                Text(info.description.isEmpty ? info.name : info.description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            if let status {
                Image(systemName: status.symbolName)
                    .font(.caption)
                    .foregroundStyle(statusTint(status))
            }
        }
        .contentShape(Rectangle())
        .hoverEffect(.highlight)
    }

    private func statusTint(_ s: CapabilityAuthorizationProbe.Status) -> Color {
        switch s {
        case .authorized: return .green
        case .limited: return .blue
        case .denied, .unavailable: return .orange
        case .notDetermined, .unknown: return .secondary
        }
    }

    private func categoryTitle(_ c: OffloadCommandCategory) -> String {
        switch c {
        case .privacy: return String(localized: "Personal data & device")
        case .media: return String(localized: "Content & media")
        case .system: return String(localized: "System & tools")
        }
    }
}

private struct CapabilityDetailView: View {
    let info: OffloadCommandInfo

    @ObservedObject private var probe = CapabilityAuthorizationProbe.shared
    @ObservedObject private var permissions = OffloadPermissionManager.shared

    var body: some View {
        List {
            Section {
                LabeledContent("System authorization") {
                    if let s = probe.statuses[info.name] {
                        Text(s.label)
                            .foregroundStyle(s.isProblem ? .orange : .secondary)
                    } else {
                        Text("—").foregroundStyle(.secondary)
                    }
                }
                LabeledContent("Command") {
                    Text(info.name)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text(info.displayLabel)
            } footer: {
                Text("“System authorization” is the iOS-level permission; the in-app gate below is an extra one this app adds. Both must pass before a capability runs.")
            }

            if info.showInSettings {
                Section("In-app gate") {
                    Picker("Before running", selection: Binding(
                        get: { permissions.permissionLevel(for: info.name) },
                        set: { permissions.setPermissionLevel($0, for: info.name) }
                    )) {
                        Text("Run directly").tag(OffloadPermissionLevel.bypass)
                        Text("Ask every time").tag(OffloadPermissionLevel.askOnce)
                        Text("Never allow").tag(OffloadPermissionLevel.notAllowed)
                    }
                }
            }

            if !info.actions.isEmpty {
                Section("What it can do") {
                    ForEach(info.actions, id: \.self) { action in
                        Label(action, systemImage: "checkmark")
                            .font(.subheadline)
                            .labelStyle(.titleAndIcon)
                    }
                }
            }

            Section("Try saying") {
                Text(info.examplePrompt)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Section("Where the data goes") {
                Text(info.dataDestination)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(info.displayLabel)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { probe.refresh() }
    }
}
