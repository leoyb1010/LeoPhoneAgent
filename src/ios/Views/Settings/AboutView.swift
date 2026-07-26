import SwiftUI
import UIKit

struct AboutView: View {
    private let appVersion: String = {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }()

    var body: some View {
        List {
            // MARK: - Project Info
            Section {
                VStack(spacing: 8) {
                    if let icon = UIImage(named: "AppIcon60x60") ?? UIImage(named: "AppIcon") {
                        Image(uiImage: icon)
                            .resizable()
                            .frame(width: 80, height: 80)
                            .clipShape(RoundedRectangle(cornerRadius: 18))
                            .overlay(
                                RoundedRectangle(cornerRadius: 18)
                                    .stroke(Color(UIColor.separator), lineWidth: 0.5)
                            )
                    }
                    Text("LeoPhoneAgent")
                        .font(.title2.bold())
                    Text("Version \(appVersion)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text("A personal iOS agent that runs tools on your device and connects to the AI providers you choose.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .listRowBackground(Color.clear)
            }

            // MARK: - Links
            Section("Links") {
                Link(destination: URL(string: "https://github.com/leoyb1010/LeoPhoneAgent")!) {
                    Label {
                        HStack {
                            Text("GitHub Repository")
                                .foregroundStyle(Color(UIColor.label))
                            Spacer()
                            Image(systemName: "arrow.up.right.square")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "link.circle.fill")
                    }
                }
                Link(destination: URL(string: "https://github.com/leoyb1010/LeoPhoneAgent/issues")!) {
                    Label {
                        HStack {
                            Text("Report an Issue")
                                .foregroundStyle(Color(UIColor.label))
                            Spacer()
                            Image(systemName: "arrow.up.right.square")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    } icon: {
                        Image(systemName: "exclamationmark.circle.fill")
                    }
                }
            }

            Section("版本") {
                NavigationLink {
                    LeoReleaseNotesView(mode: .history)
                } label: {
                    Label("更新记录", systemImage: "clock.arrow.circlepath")
                }
                LabeledContent("版本规则", value: "1.0.1 → 1.0.2")
            }
        }
        .navigationTitle("About")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct LeoPrivacyView: View {
    var body: some View {
        List {
            Section("On This Device") {
                privacyRow(
                    "Chats and Files",
                    detail: "Conversations, attachments, agent workspaces, and settings are stored in the app container."
                )
                privacyRow(
                    "Diagnostic Logs",
                    detail: "Logs can contain shell output and technical details. Review them before exporting or sharing."
                )
            }

            Section("iCloud Sync") {
                Text("When iCloud Sync is enabled, LeoPhoneAgent syncs supported conversations, files, settings, and provider configuration through your private iCloud account. Provider credentials may be encoded in synchronized configuration; encoding is not encryption provided by LeoPhoneAgent.")
            }

            Section("AI Providers") {
                Text("Prompts, relevant conversation history, attachments, and tool results are sent directly to the provider selected for a task. The provider's own privacy policy and retention rules apply.")
            }

            Section("Device Capabilities") {
                Text("When you approve a native capability, the agent may read or change the requested data. For example, Photos can find, organize, save, or delete items, and Calendar can read or create events.")
                Text("The in-app permission gate covers direct native command calls. iOS system permissions remain the final control and can be changed in the Settings app.")
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Privacy & Data")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func privacyRow(_ title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.body.weight(.medium))
            Text(detail)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}
