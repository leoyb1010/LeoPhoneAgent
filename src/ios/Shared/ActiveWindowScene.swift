//
//  ActiveWindowScene.swift
//  MinisApp
//
//  [T-multiwindow-presentation-anchor] Picking a window scene to present from.
//
//  `connectedScenes.compactMap { $0 as? UIWindowScene }.first` was used all
//  over the OAuth / Safari / share paths. `connectedScenes` is a Set, so
//  `.first` is arbitrary — with one window it happens to be right, and the app
//  now declares `UIApplicationSupportsMultipleScenes`, so on iPad a second
//  window makes it a coin flip. The visible symptom is a sign-in sheet
//  appearing in the window the user is NOT looking at (or, for a backgrounded
//  scene, not appearing at all).
//
//  Prefer the scene the user is actually driving, and degrade in a defined
//  order rather than at random.
//

import UIKit

extension Array where Element == UIWindowScene {
    /// The foreground-active scene, else any foreground scene, else any scene.
    var activeFirst: UIWindowScene? {
        first { $0.activationState == .foregroundActive }
            ?? first { $0.activationState == .foregroundInactive }
            ?? first
    }
}

extension UIApplication {
    /// The window scene a modal should be presented from.
    var leoActiveWindowScene: UIWindowScene? {
        connectedScenes.compactMap { $0 as? UIWindowScene }.activeFirst
    }

    /// Key window of the scene the user is currently driving.
    var leoActiveKeyWindow: UIWindow? {
        leoActiveWindowScene?.windows.first { $0.isKeyWindow }
            ?? leoActiveWindowScene?.windows.first
    }
}
