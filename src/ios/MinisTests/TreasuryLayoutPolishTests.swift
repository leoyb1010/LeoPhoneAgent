import XCTest

/// [T-treasury-layout] 藏宝阁第二轮:顶部块的取舍、剪贴板条、选择模式全选 / 批量归档、
/// 未连接资料库时的范围、资料库内容的显示文字。
final class TreasuryLayoutPolishTests: XCTestCase {

    // MARK: Header stack

    private func layout(height: CGFloat = 600, count: Int = 12, searching: Bool = false,
                        editing: Bool = false, phone: Bool = true) -> TreasuryHeaderPolicy.Layout {
        TreasuryHeaderPolicy.layout(containerHeight: height, itemCount: count, searching: searching,
                                    editing: editing, showsPhoneItems: phone)
    }

    func testCompactPhoneWithContentShowsOnlyViewPickerBeforeResults() {
        // iPhone SE / mini / 普通 iPhone:概览卡和四个大按钮都收起,第一条内容紧跟在胶囊后面。
        for height in [CGFloat(548), 620, 700, 780] {
            XCTAssertEqual(layout(height: height),
                           .init(showsOverview: false, showsCaptureGrid: false, showsViewPicker: true),
                           "height \(height)")
        }
    }

    func testRoomyContainerKeepsOverviewAndCaptureGrid() {
        XCTAssertEqual(layout(height: 1000),
                       .init(showsOverview: true, showsCaptureGrid: true, showsViewPicker: true))
        XCTAssertEqual(layout(height: TreasuryHeaderPolicy.roomyHeight).showsOverview, true)
    }

    func testFirstRunShowsCaptureGridButNoOverviewOrViewChips() {
        XCTAssertEqual(layout(height: 548, count: 0),
                       .init(showsOverview: false, showsCaptureGrid: true, showsViewPicker: false))
        XCTAssertEqual(layout(height: 1000, count: 0),
                       .init(showsOverview: false, showsCaptureGrid: true, showsViewPicker: false))
    }

    func testSearchingCollapsesEverythingButTheFilterRow() {
        XCTAssertEqual(layout(height: 1000, searching: true),
                       .init(showsOverview: false, showsCaptureGrid: false, showsViewPicker: true))
        XCTAssertEqual(layout(count: 0, searching: true),
                       .init(showsOverview: false, showsCaptureGrid: false, showsViewPicker: false))
    }

    func testEditingOrArchiveScopeShowsNoPhoneHeader() {
        let none = TreasuryHeaderPolicy.Layout(showsOverview: false, showsCaptureGrid: false, showsViewPicker: false)
        XCTAssertEqual(layout(height: 1000, editing: true), none)
        XCTAssertEqual(layout(height: 1000, phone: false), none)
        XCTAssertEqual(layout(height: .infinity, count: 3).showsOverview, false, "unmeasured height is not roomy")
    }

    // MARK: Clipboard banner

    func testClipboardBannerOnlyForLinksAndNotAfterHandled() {
        XCTAssertFalse(TreasuryClipboardBannerPolicy.shows(hasProbableLink: false, changeCount: 4,
                                                          dismissedChangeCount: nil, searching: false, editing: false),
                       "plain text on the clipboard no longer pins a banner")
        XCTAssertTrue(TreasuryClipboardBannerPolicy.shows(hasProbableLink: true, changeCount: 4,
                                                         dismissedChangeCount: nil, searching: false, editing: false))
        XCTAssertFalse(TreasuryClipboardBannerPolicy.shows(hasProbableLink: true, changeCount: 4,
                                                          dismissedChangeCount: 4, searching: false, editing: false),
                       "same clipboard after paste / dismiss stays hidden")
        XCTAssertTrue(TreasuryClipboardBannerPolicy.shows(hasProbableLink: true, changeCount: 5,
                                                         dismissedChangeCount: 4, searching: false, editing: false),
                       "a newly copied link shows again")
        XCTAssertFalse(TreasuryClipboardBannerPolicy.shows(hasProbableLink: true, changeCount: 5,
                                                          dismissedChangeCount: nil, searching: true, editing: false))
        XCTAssertFalse(TreasuryClipboardBannerPolicy.shows(hasProbableLink: true, changeCount: 5,
                                                          dismissedChangeCount: nil, searching: false, editing: true))
    }

    // MARK: Selection

    func testToggleAllSelectsVisibleThenClearsOnlyVisible() {
        let visible = ["a", "b", "c"]
        let all = TreasurySelection.toggleAll(selection: ["a"], visibleIDs: visible)
        XCTAssertEqual(all, ["a", "b", "c"])
        XCTAssertTrue(TreasurySelection.allSelected(selection: all, visibleIDs: visible))
        // 筛选外之前选中的(z)不受「取消全选」影响
        let cleared = TreasurySelection.toggleAll(selection: ["a", "b", "c", "z"], visibleIDs: visible)
        XCTAssertEqual(cleared, ["z"])
        XCTAssertEqual(TreasurySelection.toggleAll(selection: ["z"], visibleIDs: []), ["z"])
        XCTAssertFalse(TreasurySelection.allSelected(selection: [], visibleIDs: []))
    }

    func testBulkArchiveOnlyTouchesSelectedItemsNeedingChange() {
        var a = CollectedItem(kind: .text, value: "a", sourceLabel: "文本")
        let b = CollectedItem(kind: .text, value: "b", sourceLabel: "文本")
        var c = CollectedItem(kind: .text, value: "c", sourceLabel: "文本")
        c.archived = true
        a.updatedAt = Date(timeIntervalSince1970: 0)
        let now = Date(timeIntervalSince1970: 1_000)
        let archived = TreasurySelection.archiving([a, b, c], ids: [a.id, c.id], archive: true, now: now)
        XCTAssertEqual(archived.map(\.id), [a.id], "already archived c and unselected b are untouched")
        XCTAssertEqual(archived.first?.archived, true)
        XCTAssertEqual(archived.first?.updatedAt, now)

        let restored = TreasurySelection.archiving([a, b, c], ids: [a.id, c.id], archive: false, now: now)
        XCTAssertEqual(restored.map(\.id), [c.id])
        XCTAssertEqual(restored.first?.archived, false)
    }

    // MARK: Scope without archive connection

    func testUnconfiguredArchiveFallsBackToPhoneAndHidesPicker() {
        for stored in BrainBrowseScope.allCases {
            XCTAssertEqual(BrainBrowseScope.effective(stored, configured: false), .phone)
            XCTAssertEqual(BrainBrowseScope.effective(stored, configured: true), stored)
        }
        XCTAssertFalse(BrainBrowseScope.showsPicker(configured: false))
        XCTAssertTrue(BrainBrowseScope.showsPicker(configured: true))
        XCTAssertFalse(BrainBrowseScope.effective(.archive, configured: false).searchPrompt.contains("资料库"))
    }

    // MARK: Archive display text

    func testStatusCodesAreLocalized() {
        XCTAssertNil(BrainDisplay.status(nil))
        XCTAssertNil(BrainDisplay.status("  "))
        XCTAssertEqual(BrainDisplay.status("draft"), String(localized: "草稿"))
        XCTAssertEqual(BrainDisplay.status("Confirmed"), String(localized: "已确认"))
        XCTAssertEqual(BrainDisplay.status("reference"), String(localized: "参考"))
        XCTAssertEqual(BrainDisplay.status("archived"), "archived", "unknown codes pass through")
    }

    func testISODatesBecomeReadable() {
        let utc = TimeZone(identifier: "UTC")!
        let locale = Locale(identifier: "zh_CN")
        for raw in ["2026-10-10T12:34:56Z", "2026-10-10T12:34:56.789Z", "2026-10-10T20:34:56+08:00"] {
            XCTAssertNotNil(BrainDisplay.parseDate(raw), raw)
            let shown = BrainDisplay.date(raw, locale: locale, timeZone: utc)
            XCTAssertNotEqual(shown, raw)
            XCTAssertFalse(shown?.contains("T12") ?? true, shown ?? "")
            XCTAssertTrue(shown?.contains("12:34") ?? false, shown ?? "")
        }
        XCTAssertEqual(BrainDisplay.date("昨天"), "昨天", "unparseable stays as-is")
        XCTAssertNil(BrainDisplay.date(nil))
        XCTAssertNil(BrainDisplay.date(""))
    }

    func testCardSourceLabelHidesOpaqueFileId() {
        XCTAssertEqual(BrainDisplay.sourceLabel(index: 0, locator: nil), String(localized: "出处 \(1)"))
        let withLocator = BrainDisplay.sourceLabel(index: 1, locator: " 第3页 ")
        XCTAssertTrue(withLocator.hasSuffix(" · 第3页"))
        XCTAssertTrue(withLocator.hasPrefix(String(localized: "出处 \(2)")))
    }

    // MARK: Share

    func testSharePayloadPerKind() {
        var link = CollectedItem(kind: .link, value: "https://xhslink.com/a/1", sourceLabel: "小红书")
        XCTAssertEqual(TreasuryShareItem.payload(for: link, fileURL: { _ in nil }),
                       .url(URL(string: "https://xhslink.com/a/1")!))
        link.resolvedURL = "https://www.xiaohongshu.com/explore/1"
        XCTAssertEqual(TreasuryShareItem.payload(for: link, fileURL: { _ in nil }),
                       .url(URL(string: "https://www.xiaohongshu.com/explore/1")!), "share the resolved link")

        let text = CollectedItem(kind: .text, value: "一段摘抄", sourceLabel: "文本")
        XCTAssertEqual(TreasuryShareItem.payload(for: text, fileURL: { _ in nil }), .text("一段摘抄"))
        let blank = CollectedItem(kind: .text, value: "   ", sourceLabel: "文本")
        XCTAssertNil(TreasuryShareItem.payload(for: blank, fileURL: { _ in nil }))

        let file = CollectedItem(kind: .file, value: "report.pdf", sourceLabel: "文件")
        let fileURL = URL(fileURLWithPath: "/tmp/report.pdf")
        XCTAssertEqual(TreasuryShareItem.payload(for: file, fileURL: { $0 == "report.pdf" ? fileURL : nil }), .url(fileURL))
        XCTAssertNil(TreasuryShareItem.payload(for: file, fileURL: { _ in nil }), "missing file: no share entry")

        XCTAssertNil(TreasuryShareItem.payload(for: CollectedItem.newNote(), fileURL: { _ in nil }))
    }
}
