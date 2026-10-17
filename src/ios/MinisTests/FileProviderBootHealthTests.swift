import XCTest

/// WP-40:FileProvider 启动死循环熔断(移植 OpenMinis v1.14 FileProviderBootHealth)。
final class FileProviderBootHealthTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("fp-boot-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        FileProviderBootHealth.storageDirectoryOverride = dir
    }

    override func tearDownWithError() throws {
        FileProviderBootHealth.storageDirectoryOverride = nil
        try? FileManager.default.removeItem(at: dir)
    }

    func testTripsOnlyAfterThresholdWithoutABoot() {
        let gen = "build-1"
        for n in 1..<FileProviderBootHealth.tripThreshold {
            XCTAssertEqual(FileProviderBootHealth.noteRegistrationAttempt(generation: gen), n)
            XCTAssertFalse(FileProviderBootHealth.shouldWithholdRegistration(generation: gen, onMac: true))
        }
        FileProviderBootHealth.noteRegistrationAttempt(generation: gen)
        XCTAssertTrue(FileProviderBootHealth.shouldWithholdRegistration(generation: gen, onMac: true))
        // 真机 iOS 永不熔断:那里应该一直重试,而不是悄悄丢掉「文件」集成。
        XCTAssertFalse(FileProviderBootHealth.shouldWithholdRegistration(generation: gen, onMac: false))
    }

    func testOneSuccessfulBootHealsAndNewBuildStartsClean() {
        for _ in 0..<FileProviderBootHealth.tripThreshold {
            FileProviderBootHealth.noteRegistrationAttempt(generation: "old")
        }
        XCTAssertTrue(FileProviderBootHealth.shouldWithholdRegistration(generation: "old", onMac: true))
        XCTAssertFalse(FileProviderBootHealth.shouldWithholdRegistration(generation: "new", onMac: true))
        XCTAssertEqual(FileProviderBootHealth.noteRegistrationAttempt(generation: "new"), 1)
        FileProviderBootHealth.recordSuccessfulBoot(generation: "new")
        XCTAssertEqual(FileProviderBootHealth.noteRegistrationAttempt(generation: "new"), 1)
        XCTAssertTrue(FileProviderBootHealth.describe().contains("pending="))
    }

    func testAppAndExtensionAreWiredToTheBreaker() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let app = try String(contentsOf: root.appendingPathComponent("MinisApp.swift"), encoding: .utf8)
        let ext = try String(contentsOf: root.appendingPathComponent("FileProvider/FileProviderExtension.swift"), encoding: .utf8)
        XCTAssertTrue(app.contains("FileProviderBootHealth.shouldWithholdRegistration()"))
        XCTAssertTrue(app.contains("FileProviderBootHealth.noteRegistrationAttempt()"))
        XCTAssertTrue(ext.contains("FileProviderBootHealth.recordSuccessfulBoot()"))
    }
}
