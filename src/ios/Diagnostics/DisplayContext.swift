//
//  DisplayContext.swift
//  MinisApp
//
//  [duo-diag] Which display a LeoBot window is on and how big it is, for
//  diagnostics. On iPhone Duo the same scene moves between the outer display
//  (≈ 466 × 678 pt) and the inner one (≈ 951 × 669 pt, 669 × 951 when held
//  upright); a layout bug is only reproducible with that pair of facts.
//  Pure logic (Foundation + CoreGraphics), shared by the app and the logic tests.
//

import CoreGraphics
import Foundation

enum DisplayContext {
    enum Display: String, Equatable {
        /// iPhone Duo, closed.
        case outer
        /// iPhone Duo, open.
        case inner
        /// Any other screen (regular iPhone, iPad, external display).
        case single
    }

    /// Point sizes from the iPhone Duo device profile (portrait width × height).
    static let outerSize = CGSize(width: 466, height: 678)
    static let innerSize = CGSize(width: 669, height: 951)
    /// Slack for a later profile revision or a rounding difference.
    static let tolerance: CGFloat = 12

    /// Infers the display from the bounds of the SCREEN the scene is on (not the
    /// window: split view and stacked windows are smaller than the display).
    /// Orientation does not matter.
    static func display(screenSize: CGSize) -> Display {
        if matches(screenSize, outerSize) { return .outer }
        if matches(screenSize, innerSize) { return .inner }
        return .single
    }

    /// One short line: "display=inner screen=951x669 window=475x669".
    static func summary(screenSize: CGSize, windowSize: CGSize) -> String {
        "display=\(display(screenSize: screenSize).rawValue) screen=\(format(screenSize)) window=\(format(windowSize))"
    }

    static func format(_ size: CGSize) -> String {
        "\(Int(size.width.rounded()))x\(Int(size.height.rounded()))"
    }

    private static func matches(_ size: CGSize, _ reference: CGSize) -> Bool {
        let short = min(size.width, size.height), long = max(size.width, size.height)
        return abs(short - reference.width) <= tolerance && abs(long - reference.height) <= tolerance
    }

    // MARK: Latest value, readable from any thread (crash marker, feedback export)

    private static let lock = NSLock()
    nonisolated(unsafe) private static var _current = "display=unknown"

    /// The summary of the window scene that last changed size or became active.
    static var current: String {
        lock.lock(); defer { lock.unlock() }
        return _current
    }

    static func setCurrent(_ summary: String) {
        lock.lock(); defer { lock.unlock() }
        _current = summary
    }
}
