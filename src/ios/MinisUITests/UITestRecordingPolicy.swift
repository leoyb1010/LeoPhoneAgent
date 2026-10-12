import Foundation

/// [T-uitest-no-recording] Xcode 15+ screen-records every UI test and keeps the
/// video on the device (testmanagerd's tmp/Attachments, shown as "System Data")
/// unless the test passes. A device tour that fails or is killed would leave
/// its video behind, and a reboot does not clear it. XCTest skips recording
/// when these defaults are set before a test case starts, so every UI test
/// class calls `apply()` from `class func setUp()`.
enum UITestRecordingPolicy {
    static func apply() {
        // Registration domain: not persisted, and nothing else sets these keys.
        UserDefaults.standard.register(defaults: [
            "DisableDiagnosticScreenRecordings": true,
            "DisableDiagnosticScreenshots": true,
        ])
    }
}
