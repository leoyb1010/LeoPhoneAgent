import XCTest

/// [duo-shell] iPhone Duo (Xcode 27.1 device profile): every shell layout
/// decision at the widths the device and its multitasking modes produce, plus
/// iPad / mirroring widths. The rules take only width and size classes, so
/// each scenario is checked with the iPhone idiom the Duo reports and with the
/// iPad idiom; the decisions must be identical.
final class IPhoneDuoLayoutTests: XCTestCase {
    typealias L = LeoWorkspaceLayoutPolicy

    enum Idiom: CaseIterable { case phone, pad }

    struct Window {
        let name: String
        let width: CGFloat
        let height: CGFloat
        let regularWidth: Bool
        let regularHeight: Bool
    }

    struct Decision: Equatable, CustomStringConvertible {
        var split: Bool
        var sidebarResident: Bool      // meaningful only when split
        var settingsTwoColumns: Bool   // settings sheet filling the window
        var treasurySplit: Bool
        var inspectorAutoOpens: Bool
        var inspectorPinnable: Bool
        var quickHome: Bool

        var description: String {
            "split=\(split) resident=\(sidebarResident) settings2=\(settingsTwoColumns) "
                + "treasury=\(treasurySplit) autoInspector=\(inspectorAutoOpens) "
                + "pinnable=\(inspectorPinnable) quick=\(quickHome)"
        }
    }

    /// Everything the shell decides for one window. `idiom` is deliberately
    /// unused: it is here to prove the decisions don't depend on it.
    static func decide(_ w: Window, idiom: Idiom) -> Decision {
        _ = idiom
        let split = L.usesSplit(width: w.width, regularWidth: w.regularWidth, regularHeight: w.regularHeight)
        return Decision(
            split: split,
            sidebarResident: split && L.sidebarResident(width: w.width),
            settingsTwoColumns: LeoSettingsLayoutPolicy.usesTwoColumns(width: w.width),
            treasurySplit: TreasuryWorkspaceLayoutPolicy.usesSplit(width: w.width, regularWidth: w.regularWidth),
            // The inspector only exists inside the split shell's detail column.
            inspectorAutoOpens: split && L.showsContextColumn(width: w.width),
            inspectorPinnable: split && L.canPinContextColumn(width: w.width),
            quickHome: !split && L.usesQuickHome(width: w.width, height: w.height, regularWidth: w.regularWidth))
    }

    private func d(split: Bool, resident: Bool = false, settings2: Bool, treasury: Bool,
                   auto: Bool = false, pin: Bool = false, quick: Bool = false) -> Decision {
        Decision(split: split, sidebarResident: resident, settingsTwoColumns: settings2,
                 treasurySplit: treasury, inspectorAutoOpens: auto, inspectorPinnable: pin, quickHome: quick)
    }

    // MARK: - Required widths

    func testRequiredWidths() {
        let cases: [(Window, Decision)] = [
            // Duo outer portrait: compact / regular.
            (Window(name: "outer portrait", width: 466, height: 678, regularWidth: false, regularHeight: true),
             d(split: false, settings2: false, treasury: false, quick: true)),
            // Half of the inner display in split view: compact width.
            (Window(name: "inner split half", width: 475, height: 669, regularWidth: false, regularHeight: true),
             d(split: false, settings2: false, treasury: false, quick: true)),
            // Inner portrait: regular / regular but too narrow for any split.
            (Window(name: "inner portrait", width: 669, height: 951, regularWidth: true, regularHeight: true),
             d(split: false, settings2: false, treasury: false)),
            // Outer landscape: compact / compact.
            (Window(name: "outer landscape", width: 678, height: 466, regularWidth: false, regularHeight: false),
             d(split: false, settings2: false, treasury: false)),
            (Window(name: "split floor", width: 740, height: 900, regularWidth: true, regularHeight: true),
             d(split: true, resident: false, settings2: true, treasury: false)),
            (Window(name: "drawer band", width: 780, height: 900, regularWidth: true, regularHeight: true),
             d(split: true, resident: false, settings2: true, treasury: true)),
            (Window(name: "resident floor", width: 800, height: 900, regularWidth: true, regularHeight: true),
             d(split: true, resident: true, settings2: true, treasury: true)),
            // Duo inner landscape: three columns possible, inspector only by pin.
            (Window(name: "inner landscape", width: 951, height: 669, regularWidth: true, regularHeight: true),
             d(split: true, resident: true, settings2: true, treasury: true, auto: false, pin: true)),
            // iPhone mirroring on a Mac / external display, wider than 951.
            (Window(name: "mirrored 1100", width: 1100, height: 800, regularWidth: true, regularHeight: true),
             d(split: true, resident: true, settings2: true, treasury: true, auto: true, pin: true)),
            (Window(name: "mirrored 1300", width: 1300, height: 900, regularWidth: true, regularHeight: true),
             d(split: true, resident: true, settings2: true, treasury: true, auto: true, pin: true)),
        ]
        for (window, expected) in cases {
            for idiom in Idiom.allCases {
                XCTAssertEqual(Self.decide(window, idiom: idiom), expected, "\(window.name) \(window.width) pt, \(idiom)")
            }
        }
    }

    func testNearSquareWindows() {
        // Stage Manager / mirroring can produce near-square regular windows;
        // height never changes the outcome, only width and the size classes.
        let cases: [(Window, Decision)] = [
            (Window(name: "669 square", width: 669, height: 680, regularWidth: true, regularHeight: true),
             d(split: false, settings2: false, treasury: false)),
            (Window(name: "740 square", width: 740, height: 740, regularWidth: true, regularHeight: true),
             d(split: true, settings2: true, treasury: false)),
            (Window(name: "800 square", width: 800, height: 790, regularWidth: true, regularHeight: true),
             d(split: true, resident: true, settings2: true, treasury: true)),
            (Window(name: "951 square", width: 951, height: 951, regularWidth: true, regularHeight: true),
             d(split: true, resident: true, settings2: true, treasury: true, pin: true)),
            (Window(name: "1100 square", width: 1100, height: 1100, regularWidth: true, regularHeight: true),
             d(split: true, resident: true, settings2: true, treasury: true, auto: true, pin: true)),
        ]
        for (window, expected) in cases {
            for idiom in Idiom.allCases {
                XCTAssertEqual(Self.decide(window, idiom: idiom), expected, "\(window.name), \(idiom)")
            }
            // Swapping width and height of a square-ish window with the same size
            // classes only matters through width.
            let rotated = Window(name: window.name + " rotated", width: window.height, height: window.width,
                                 regularWidth: window.regularWidth, regularHeight: window.regularHeight)
            XCTAssertEqual(Self.decide(rotated, idiom: .phone).split,
                           L.usesSplit(width: window.height, regularWidth: true, regularHeight: true))
        }
    }

    // MARK: - Margins

    /// Each threshold keeps ≥ 50 pt from the nearest Duo width, so a ±20 pt
    /// change in margins or safe areas cannot flip a Duo layout.
    func testDuoWidthsKeepAMarginToEveryThreshold() {
        let duoWidths: [CGFloat] = [466, 475, 669, 678, 951]
        let thresholds: [(String, CGFloat)] = [
            ("split", L.splitMinWidth),
            ("resident sidebar", L.residentSidebarMinWidth),
            ("inspector pin", L.contextColumnPinMinWidth),
            ("inspector auto", L.contextColumnMinWidth),
            ("settings two columns", LeoSettingsLayoutPolicy.twoColumnMinWidth),
            ("treasury split", TreasuryWorkspaceLayoutPolicy.splitMinWidth),
            ("quick home", L.quickHomeMaxWidth),
        ]
        for (name, threshold) in thresholds {
            for width in duoWidths {
                XCTAssertGreaterThanOrEqual(abs(threshold - width), 20, "\(name) \(threshold) vs Duo \(width)")
            }
        }
        // The two the plan flagged: inner portrait 669 vs settings and split.
        // Settings stays at 700 so the iPad page sheet (≈ 704) keeps two columns:
        // 31 pt above inner portrait, still outside the ±20 pt band.
        XCTAssertGreaterThanOrEqual(LeoSettingsLayoutPolicy.twoColumnMinWidth - 669, 30)
        XCTAssertGreaterThanOrEqual(L.splitMinWidth - 669, 50)
        for delta: CGFloat in [-20, 0, 20] {
            XCTAssertFalse(LeoSettingsLayoutPolicy.usesTwoColumns(width: 669 + delta))
            XCTAssertFalse(L.usesSplit(width: 669 + delta, regularWidth: true, regularHeight: true))
            XCTAssertTrue(LeoSettingsLayoutPolicy.usesTwoColumns(width: 951 + delta))
            XCTAssertTrue(L.usesSplit(width: 951 + delta, regularWidth: true, regularHeight: true))
            XCTAssertTrue(L.sidebarResident(width: 951 + delta))
            XCTAssertTrue(L.canPinContextColumn(width: 951 + delta))
            XCTAssertFalse(L.showsContextColumn(width: 951 + delta))
        }
    }

    /// Settings is presented with `.sheet`; on iPad that is a page sheet about
    /// 704 pt wide, which must keep the sidebar + page layout.
    func testIPadPageSheetSettingsIsTwoColumns() {
        XCTAssertTrue(LeoSettingsLayoutPolicy.usesTwoColumns(width: 704), "iPad page sheet")
        XCTAssertTrue(LeoSettingsLayoutPolicy.usesTwoColumns(width: 744))
        XCTAssertFalse(LeoSettingsLayoutPolicy.usesTwoColumns(width: 669), "Duo inner portrait")
    }

    func testThresholdValuesAndDerivations() {
        XCTAssertEqual(L.splitMinWidth, 740)
        XCTAssertFalse(L.usesSplit(width: 739, regularWidth: true, regularHeight: true))
        XCTAssertTrue(L.usesSplit(width: 740, regularWidth: true, regularHeight: true))
        XCTAssertEqual(L.residentSidebarMinWidth, 800)
        XCTAssertEqual(L.contextColumnPinMinWidth, 900)
        XCTAssertEqual(L.contextColumnMinWidth, 1100)
        XCTAssertEqual(LeoSettingsLayoutPolicy.twoColumnMinWidth, 700)
        XCTAssertFalse(LeoSettingsLayoutPolicy.usesTwoColumns(width: 699))
        XCTAssertTrue(LeoSettingsLayoutPolicy.usesTwoColumns(width: 700))
        XCTAssertFalse(LeoSettingsLayoutPolicy.usesTwoColumns(width: .nan))
        // Settings sidebar + page floor = the threshold.
        XCTAssertEqual(LeoSettingsLayoutPolicy.sidebarWidth.min + LeoSettingsLayoutPolicy.detailMinWidth,
                       LeoSettingsLayoutPolicy.twoColumnMinWidth)
        XCTAssertEqual(TreasuryWorkspaceLayoutPolicy.splitMinWidth, 760)
        XCTAssertEqual(L.quickHomeMaxWidth, 500)
        // Three ≥ 300 pt columns fit at the pin width.
        XCTAssertGreaterThanOrEqual(L.contextColumnPinMinWidth, L.sidebarWidth.ideal + 300 + 300)
        // Sidebar ideal + inspector ideal (360) + chat floor = auto-open width.
        XCTAssertEqual(L.sidebarWidth.ideal + 360 + L.splitDetailMinWidth, L.contextColumnMinWidth)
    }

    // MARK: - Fold / unfold and the inspector pin

    func testInspectorPinAcrossFoldAndResize() {
        func rule(_ pinned: Bool) -> (CGFloat) -> Bool { { L.opensContextColumn(width: $0, pinned: pinned) } }
        // Not pinned: unfolding a Duo (first measurement at 951) leaves it closed.
        XCTAssertEqual(L.crossing(from: 0, to: 951, rule: rule(false)), false)
        // Pinned: opens on the first measurement at 951 …
        XCTAssertEqual(L.crossing(from: 0, to: 951, rule: rule(true)), true)
        // … and when a window grows back over 900 (inner portrait → landscape).
        XCTAssertEqual(L.crossing(from: 669, to: 951, rule: rule(true)), true)
        XCTAssertEqual(L.crossing(from: 951, to: 669, rule: rule(true)), false)
        // Pinned survives 1300 → 951 (mirroring window shrunk); unpinned closes.
        XCTAssertNil(L.crossing(from: 1300, to: 951, rule: rule(true)))
        XCTAssertEqual(L.crossing(from: 1300, to: 951, rule: rule(false)), false)
        // Same side of every threshold: the user's own toggle stands.
        XCTAssertNil(L.crossing(from: 951, to: 960, rule: rule(false)))
        XCTAssertNil(L.crossing(from: 951, to: 960, rule: rule(true)))
        // Below the pin width the pin does nothing.
        XCTAssertFalse(L.opensContextColumn(width: 899, pinned: true))
        XCTAssertTrue(L.opensContextColumn(width: 900, pinned: true))
        XCTAssertFalse(L.opensContextColumn(width: 1099, pinned: false))
        XCTAssertTrue(L.opensContextColumn(width: 1100, pinned: false))
    }

    func testSidebarFollowsFoldAndUnfold() {
        // Folded (466) → unfolded landscape (951): sidebar becomes resident.
        XCTAssertEqual(L.crossing(from: 466, to: 951, rule: L.sidebarResident), true)
        // Unfolded → folded: rule says drawer; the stack layout takes over anyway.
        XCTAssertEqual(L.crossing(from: 951, to: 466, rule: L.sidebarResident), false)
        // Inner landscape ↔ portrait.
        XCTAssertEqual(L.crossing(from: 951, to: 669, rule: L.sidebarResident), false)
        // 740–800 band (iPad Stage Manager) keeps the drawer.
        XCTAssertNil(L.crossing(from: 740, to: 780, rule: L.sidebarResident))
    }

    // MARK: - P0-4 single column at ≈ 475 pt

    func testSplitHalfIsACompleteSingleColumn() {
        for width: CGFloat in [440, 466, 475, 500] {
            for regularHeight in [true, false] {
                // Even if the system reported regular width for a half, it stays one column.
                XCTAssertFalse(L.usesSplit(width: width, regularWidth: true, regularHeight: regularHeight), "\(width)")
                XCTAssertFalse(L.usesSplit(width: width, regularWidth: false, regularHeight: regularHeight), "\(width)")
            }
            XCTAssertFalse(LeoSettingsLayoutPolicy.usesTwoColumns(width: width))
            XCTAssertFalse(TreasuryWorkspaceLayoutPolicy.usesSplit(width: width, regularWidth: true))
        }
        XCTAssertTrue(L.usesQuickHome(width: 475, height: 669, regularWidth: false), "Duo inner split half")
        XCTAssertTrue(L.usesQuickHome(width: 466, height: 678, regularWidth: false), "Duo outer portrait")
        XCTAssertFalse(L.usesQuickHome(width: 475, height: 669, regularWidth: true))
        XCTAssertFalse(L.usesQuickHome(width: 501, height: 669, regularWidth: false))
        // 普通 iPhone 竖屏不触发:用户主力机首页不能被悄悄改
        XCTAssertFalse(L.usesQuickHome(width: 440, height: 956, regularWidth: false), "iPhone 18 Pro Max")
        XCTAssertFalse(L.usesQuickHome(width: 402, height: 874, regularWidth: false), "iPhone 18 Pro")
        XCTAssertFalse(L.usesQuickHome(width: 375, height: 667, regularWidth: false), "iPhone SE")
        XCTAssertFalse(L.usesQuickHome(width: 0, height: 678, regularWidth: false), "unmeasured window")
        XCTAssertFalse(L.usesQuickHome(width: .infinity, height: 678, regularWidth: false))
    }

    // MARK: - P1-10 nothing in the shell keys off the device idiom

    func testShellNeverReadsTheDeviceIdiom() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        func source(_ path: String) throws -> String {
            try String(contentsOf: root.appendingPathComponent(path), encoding: .utf8)
        }
        for path in ["Agent/Chat/AgentChatCorrectness.swift", "Views/Chat/ChatInspector.swift",
                     "Views/Settings/SettingsSheet.swift", "Views/LeoCommands.swift",
                     "Shared/CollectionSearchIndex.swift", "Views/CollectionsView.swift"] {
            XCTAssertFalse(try source(path).contains("userInterfaceIdiom"), path)
        }
        let content = try source("Views/ContentView.swift")
        let idiomLines = content.split(separator: "\n").filter { $0.contains("userInterfaceIdiom") }
        XCTAssertEqual(idiomLines.count, 1, "only the isIPad declaration")
        // isIPad only picks wording / icons ("此 iPad" vs "此 iPhone"), never layout.
        let uses = content.split(separator: "\n").filter {
            $0.contains("isIPad") && !$0.contains("private let isIPad") && !$0.trimmingCharacters(in: .whitespaces).hasPrefix("///")
        }
        XCTAssertFalse(uses.isEmpty)
        for line in uses {
            let wording = line.contains("\"") || line.contains("switch (isIPad, macFleetEnabled)")
            XCTAssertTrue(wording, "isIPad outside wording: \(line)")
            for layoutWord in ["Layout", "columnVisibility", "usesSplit", "Width", "inspector"] {
                XCTAssertFalse(line.contains(layoutWord), "isIPad near layout: \(line)")
            }
        }
    }
}
