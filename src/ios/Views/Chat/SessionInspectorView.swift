//
//  SessionInspectorView.swift
//  MinisApp
//
//  [T-session-inspector] "Why is this session behaving the way it is?"
//
//  Model, context pressure, token spend, and which of Memory / Skills / MCP
//  are actually feeding this conversation were each discoverable somewhere,
//  but never together — so diagnosing a session meant opening four screens
//  and inferring. This gathers them into one sheet, read-only, off the chat's
//  own state so it always reflects the live session rather than a snapshot.
//

import SwiftUI

struct SessionInspectorView: View {
    @ObservedObject var vm: AIChatViewModel
    @Environment(\.dismiss) private var dismiss

    @ObservedObject private var skills = SkillStore.shared
    @ObservedObject private var mcp = MCPStore.shared

    private var stats: (input: Int, output: Int, cacheRead: Int, cacheWrite: Int, context: Int, loopCount: Int) {
        vm.sessionTokenStats
    }

    private var contextWindow: Int {
        vm.selectedModel.contextWindowTokens
    }

    private var contextFraction: Double {
        guard contextWindow > 0, stats.context > 0 else { return 0 }
        return min(Double(stats.context) / Double(contextWindow), 1)
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Model") {
                    LabeledContent("Current model", value: vm.selectedModel.displayName)
                    if contextWindow > 0 {
                        LabeledContent("Context window", value: "\(compact(contextWindow)) tokens")
                    }
                }

                Section {
                    if stats.context > 0, contextWindow > 0 {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text("\(compact(stats.context)) / \(compact(contextWindow))")
                                    .font(.body.monospacedDigit())
                                    // [T-numeric-text-transition] These update
                                    // live while a reply streams; without this
                                    // every token makes the number hard-cut.
                                    .contentTransition(.numericText())
                                Spacer()
                                Text(String(format: "%.0f%%", contextFraction * 100))
                                    .font(.body.monospacedDigit().weight(.semibold))
                                    .contentTransition(.numericText())
                                    .foregroundStyle(contextTint)
                            }
                            ProgressView(value: contextFraction)
                                .tint(contextTint)
                        }
                        .padding(.vertical, 2)
                    } else {
                        Text("No context usage yet — send a message to see it.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    Text("Context usage")
                } footer: {
                    Text("Near the limit the history is compacted automatically (a summary is kept). That invalidates the cache and can lose early detail. Start a new session if you need the full detail preserved.")
                }

                Section("Tokens this session") {
                    LabeledContent("Input", value: compact(stats.input))
                    LabeledContent("Output", value: compact(stats.output))
                    if stats.cacheRead > 0 {
                        LabeledContent("Cache hits", value: compact(stats.cacheRead))
                    }
                    if stats.cacheWrite > 0 {
                        LabeledContent("Cache writes", value: compact(stats.cacheWrite))
                    }
                    if stats.loopCount > 0 {
                        LabeledContent("Agent iterations", value: "\(stats.loopCount)")
                    }
                }

                Section {
                    statusRow(String(localized: "Memory injection"), isOn: vm.memoryEnabled,
                              detail: vm.memoryEnabled ? String(localized: "GLOBAL.md and recent logs enter the prompt") : String(localized: "Not injected, and nothing is written for this session"))
                    statusRow(String(localized: "Skills"), isOn: enabledSkillCount > 0,
                              detail: enabledSkillCount > 0 ? String(localized: "\(enabledSkillCount) enabled") : String(localized: "None"))
                    statusRow(String(localized: "MCP servers"), isOn: enabledMCPCount > 0,
                              detail: enabledMCPCount > 0 ? String(localized: "\(enabledMCPCount) enabled") : String(localized: "None"))
                } header: {
                    Text("What is feeding this session")
                } footer: {
                    Text("These all consume context. If the model seems to wander or context is tight, check here for skills or MCP servers you don't need.")
                }

                if let sid = vm.sessionId, !sid.isEmpty {
                    Section("Session") {
                        LabeledContent("ID") {
                            Text(sid)
                                .font(.footnote.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                }
            }
            .navigationTitle("Session Inspector")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private var contextTint: Color {
        switch contextFraction {
        case ..<0.6: return .green
        case ..<0.85: return .orange
        default: return .red
        }
    }

    private var enabledSkillCount: Int {
        guard let sid = vm.sessionId, !sid.isEmpty else { return 0 }
        return skills.skills.filter {
            $0.isEnabled && skills.isEnabledForSession($0.id, sessionId: sid)
        }.count
    }

    private var enabledMCPCount: Int {
        guard let sid = vm.sessionId, !sid.isEmpty else { return 0 }
        return mcp.servers.filter {
            $0.enabled && mcp.isEnabledForSession($0.id, sessionId: sid)
        }.count
    }

    private func statusRow(_ title: String, isOn: Bool, detail: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: isOn ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(isOn ? Color.green : Color.secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.body)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    private func compact(_ value: Int) -> String {
        if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
        if value >= 1_000 { return String(format: "%.1fK", Double(value) / 1_000) }
        return "\(value)"
    }
}
