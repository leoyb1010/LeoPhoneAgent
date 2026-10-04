//
//  MCPJSONImportSheet.swift
//  MinisApp
//
//  Paste an MCP server config (Claude-Desktop mcpServers JSON or compatible
//  variants), preview the parsed servers, then commit. Mirrors the Skills
//  import UX.
//

import SwiftUI

struct MCPJSONImportSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var store = MCPStore.shared

    @State private var text: String = ""
    @State private var parsed: [MCPServerConfig] = []
    @State private var errorMessage: String?
    @State private var confirmingReplacement = false

    private var replacementNames: [String] {
        parsed.filter { candidate in store.servers.contains { $0.id == candidate.id } }.map(\.id)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(String(localized: "Paste MCP JSON")) {
                    TextEditor(text: $text)
                        .font(.system(.footnote, design: .monospaced))
                        .frame(minHeight: 220)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .onChange(of: text) { _ in
                            parsed = []
                            errorMessage = nil
                        }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }

                if !parsed.isEmpty {
                    Section(String(localized: "Preview")) {
                        Text(String(format: String(localized: "Found %d server(s)"), parsed.count))
                            .font(.subheadline.weight(.semibold))
                        ForEach(parsed) { server in
                            HStack(spacing: 8) {
                                Image(systemName: server.isSTDIO ? "terminal" : "globe")
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(server.id)
                                    if replacementNames.contains(server.id) {
                                        Text("Replaces existing server").font(.caption).foregroundStyle(.orange)
                                    }
                                }
                                Spacer()
                                Text(server.isSTDIO ? "STDIO" : "HTTP")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .alert("Replace existing MCP servers?", isPresented: $confirmingReplacement) {
                Button("Replace", role: .destructive) { commit() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The imported configuration will replace these servers: \(replacementNames.joined(separator: ", ")).")
            }
            .navigationTitle(Text("Import JSON"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(String(localized: "Cancel")) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if parsed.isEmpty {
                        Button(String(localized: "Parse")) { parse() }
                            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    } else {
                        Button(String(localized: "Import")) {
                            if replacementNames.isEmpty { commit() }
                            else { confirmingReplacement = true }
                        }
                    }
                }
            }
        }
    }

    private func parse() {
        do {
            parsed = try store.parseImport(text)
            errorMessage = nil
        } catch {
            parsed = []
            errorMessage = error.localizedDescription
        }
    }

    private func commit() {
        do {
            try store.commitImport(parsed)
            dismiss()
        } catch {
            errorMessage = String(localized: "Couldn't save the imported servers. Your JSON is still here; check available storage and try again.")
        }
    }
}
