//
//  SceneDisplayLogger.swift
//  MinisApp
//
//  [duo-diag] Logs which display each LeoBot window scene is on (iPhone Duo
//  outer / inner) and its size: one line per size change, nothing else. The
//  latest value goes into the crash marker and the feedback export
//  (`DisplayContext.current`) and into the always-on diagnostic ring, so a
//  Duo-only layout bug can be reproduced from a user's report.
//

import UIKit

@MainActor
final class SceneDisplayLogger {
    static let shared = SceneDisplayLogger()
    private init() {}

    private let logger = AppLogger(category: "SceneDisplay")
    private var installed = false
    private var observations: [ObjectIdentifier: NSKeyValueObservation] = [:]
    private var lastLogged: [ObjectIdentifier: String] = [:]

    /// Idempotent. Covers scenes connected before and after the call.
    func install() {
        guard !installed else { return }
        installed = true
        let center = NotificationCenter.default
        center.addObserver(forName: UIScene.willConnectNotification, object: nil, queue: .main) { [weak self] note in
            let scene = note.object as? UIWindowScene
            MainActor.assumeIsolated { scene.map { self?.observe($0) } }
        }
        center.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { [weak self] note in
            let scene = note.object as? UIWindowScene
            MainActor.assumeIsolated {
                guard let self, let scene else { return }
                self.observe(scene)
                // The active window is the one a report is about; no log line.
                DisplayContext.setCurrent(Self.summary(of: scene))
            }
        }
        center.addObserver(forName: UIScene.didDisconnectNotification, object: nil, queue: .main) { [weak self] note in
            guard let scene = note.object as? UIScene else { return }
            let id = ObjectIdentifier(scene)
            MainActor.assumeIsolated {
                self?.observations.removeValue(forKey: id)?.invalidate()
                self?.lastLogged.removeValue(forKey: id)
            }
        }
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            observe(scene)
        }
    }

    private func observe(_ scene: UIWindowScene) {
        let id = ObjectIdentifier(scene)
        guard observations[id] == nil else { return }
        observations[id] = scene.observe(\.effectiveGeometry, options: [.initial]) { [weak self] scene, _ in
            MainActor.assumeIsolated { self?.geometryChanged(scene) }
        }
    }

    private func geometryChanged(_ scene: UIWindowScene) {
        let summary = Self.summary(of: scene)
        let id = ObjectIdentifier(scene)
        guard lastLogged[id] != summary else { return }
        // [duo-fold] A real change (not the first reading of a scene): fold,
        // display move, rotation or resize. Gates fold continuity.
        if lastLogged[id] != nil { FoldSignal.noteGeometryChange() }
        lastLogged[id] = summary
        if scene.activationState == .foregroundActive || DisplayContext.current == "display=unknown" {
            DisplayContext.setCurrent(summary)
        }
        logger.info("[display] \(summary) state=\(scene.activationState.rawValue)")
        DiagnosticRing.shared.record(.sceneDisplay, message: summary)
    }

    private static func summary(of scene: UIWindowScene) -> String {
        DisplayContext.summary(screenSize: scene.screen.bounds.size,
                               windowSize: scene.effectiveGeometry.coordinateSpace.bounds.size)
    }
}
