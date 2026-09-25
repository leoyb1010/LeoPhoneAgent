//
//  LeoWatchApp.swift
//  LeoWatch — Apple Watch companion
//
//  The watch is something you talk to: ask by voice, read or hear the
//  answer, approve a Mac's yes/no. Near the iPhone the phone's agent does the
//  work; a cellular watch on its own asks the model directly (see
//  WatchStandaloneClient), finishing in a background URLSession when the
//  wrist drops.
//

import SwiftUI

@main
struct LeoWatchApp: App {
    @StateObject private var client = WatchConnectivityClient.shared

    var body: some Scene {
        WindowGroup {
            WatchRootView()
                .environmentObject(client)
                .onAppear { client.activate() }
        }
        // The system relaunches us (possibly in the background) to deliver a
        // direct answer that finished while we were suspended.
        .backgroundTask(.urlSession(WatchStandaloneClient.backgroundSessionId)) {
            await MainActor.run {
                _ = WatchConnectivityClient.shared   // installs the answer handler
                WatchStandaloneClient.shared.reconnectBackgroundSession()
            }
            await BackgroundAskDelegate.shared.waitForEvents()
        }
    }
}
