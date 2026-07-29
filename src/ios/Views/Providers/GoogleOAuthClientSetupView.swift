//
//  GoogleOAuthClientSetupView.swift
//  MinisApp
//
//  [T-google-oauth-byo-client] Lets the user supply their own Google OAuth
//  client so the (already complete) Gemini Cloud Code Assist sign-in can
//  actually finish its token exchange. See GoogleOAuthClientStore for why
//  the bundled constants cannot work.
//

import SwiftUI

struct GoogleOAuthClientSetupView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var clientID: String = GoogleOAuthClientStore.clientID ?? ""
    @State private var clientSecret: String = GoogleOAuthClientStore.clientSecret ?? ""
    @State private var savedNotice = false
    /// [T-google-oauth-isconfigured-observation] `GoogleOAuthClientStore.isConfigured`
    /// reads the Keychain directly, so a plain call in `body` gives SwiftUI no
    /// dependency to invalidate on. Mirror it into state and update it wherever
    /// we change the stored client.
    @State private var isConfigured = GoogleOAuthClientStore.isConfigured

    /// An iOS client needs only a well-formed ID; a desktop client needs both.
    private var canSave: Bool {
        let id = clientID.trimmingCharacters(in: .whitespaces)
        guard !id.isEmpty else { return false }
        if clientSecret.trimmingCharacters(in: .whitespaces).isEmpty {
            return id.hasSuffix(".apps.googleusercontent.com")
        }
        return true
    }

    private var detectedKindIsValid: Bool {
        let id = clientID.trimmingCharacters(in: .whitespaces)
        if clientSecret.trimmingCharacters(in: .whitespaces).isEmpty {
            return id.hasSuffix(".apps.googleusercontent.com")
        }
        return true
    }

    private var detectedKindLabel: String {
        if clientSecret.trimmingCharacters(in: .whitespaces).isEmpty {
            return detectedKindIsValid
                ? String(localized: "iOS client (PKCE, no secret)")
                : String(localized: "Client ID should end in .apps.googleusercontent.com")
        }
        return String(localized: "Desktop app client (loopback callback)")
    }

    var body: some View {
        Form {
            Section {
                Text("This app's bundled Google client secret was removed when it was open-sourced, so Gemini's \"Sign in with Google\" cannot finish authorization. Once you add your own client, the option appears among the authentication methods.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            Section {
                TextField("Client ID", text: $clientID, axis: .vertical)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .font(.footnote.monospaced())
                SecureField(String(localized: "Client Secret (leave empty for iOS type)"), text: $clientSecret)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if !clientID.isEmpty {
                    LabeledContent(String(localized: "Detected as")) {
                        Text(detectedKindLabel)
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(detectedKindIsValid ? .green : .orange)
                    }
                }
            } header: {
                Text("OAuth client")
            } footer: {
                Text("Stored in this device's Keychain — never synced, never uploaded. Gemini and Antigravity share this client. Leaving the secret empty means an iOS-type client.")
            }

            Section {
                stepRow(1, String(localized: "Open Google Cloud Console and create or pick a project"))
                stepRow(2, String(localized: "Enable the Generative Language API (or Cloud Code Assist)"))
                stepRow(3, String(localized: "APIs & Services → Credentials → Create credentials → OAuth client ID"))
                stepRow(4, String(localized: "Choose application type \"iOS\" and enter bundle ID com.leoyuan.leophoneagent"))
                stepRow(5, String(localized: "Paste the client ID above and leave the secret empty"))
                Link(destination: URL(string: "https://console.cloud.google.com/apis/credentials")!) {
                    Label("Open Google Cloud credentials", systemImage: "arrow.up.right.square")
                        .font(.footnote.weight(.medium))
                }
            } header: {
                Text("Recommended: iOS type (no secret)")
            } footer: {
                Text("iOS is the correct client type for this app: Google issues no secret and instead proves identity with PKCE plus a reversed-client-ID callback, so there is nothing to bake into the binary.")
            }

            Section {
                Text("If you already have a \"Desktop app\" client (for example one created by following Google's Gemini API OAuth guide), fill in both the ID and the secret and the loopback callback flow is used automatically.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } header: {
                Text("Also supported: Desktop app type")
            } footer: {
                Text("Note: whether a self-created client gets the same free quota as the Gemini CLI depends on Google's own client checks and is not guaranteed. Fall back to an API key if sign-in fails.")
            }

            if isConfigured {
                Section {
                    Button(role: .destructive) {
                        GoogleOAuthClientStore.clear()
                        clientID = ""
                        clientSecret = ""
                        isConfigured = false
                    } label: {
                        Label("Clear client", systemImage: "trash")
                    }
                }
            }
        }
        .navigationTitle("Google sign-in setup")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(String(localized: "Save")) {
                    GoogleOAuthClientStore.clientID = clientID.trimmingCharacters(in: .whitespaces)
                    GoogleOAuthClientStore.clientSecret = clientSecret.trimmingCharacters(in: .whitespaces)
                    isConfigured = GoogleOAuthClientStore.isConfigured
                    savedNotice = true
                }
                .disabled(!canSave)
            }
        }
        .alert(String(localized: "Saved"), isPresented: $savedNotice) {
            Button(String(localized: "OK")) { dismiss() }
        } message: {
            Text("Go back one screen and \"OAuth\" will be listed among Gemini's authentication methods.")
        }
    }

    private func stepRow(_ index: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(index)")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.white)
                .frame(width: 18, height: 18)
                .background(Color.accentColor, in: Circle())
            Text(text)
                .font(.footnote)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
