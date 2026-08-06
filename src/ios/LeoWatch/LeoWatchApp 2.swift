//
//  LeoWatchApp.swift
//  LeoWatch — Apple Watch companion
//
//  [T-watch-companion] Deliberately NOT a chat client. The phone app is where
//  conversations happen; the watch answers the two questions you actually
//  raise your wrist for:
//    1. "is the agent still working?"
//    2. "run my usual task, now."
//
//  All state arrives over WatchConnectivity — App Groups are per-device, so
//  the widget snapshot on the phone is not visible here.
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
    }
}
