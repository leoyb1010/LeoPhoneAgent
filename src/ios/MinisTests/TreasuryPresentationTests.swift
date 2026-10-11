import XCTest

/// [T-treasury-design] 藏宝阁视觉升级里的纯逻辑:命中高亮、按宽度分列、错峰上限、类型图标。
final class TreasuryPresentationTests: XCTestCase {

    // MARK: 【】 match markers

    typealias Seg = LeoMatchHighlight.Segment

    func testMarkedExcerptRendersMatchesWithoutBrackets() {
        let segs = LeoMatchHighlight.segments(markedText: "合同里写明【违约金】为总价的【百分之五】。")
        XCTAssertEqual(segs, [Seg(text: "合同里写明", isMatch: false), Seg(text: "违约金", isMatch: true),
                              Seg(text: "为总价的", isMatch: false), Seg(text: "百分之五", isMatch: true),
                              Seg(text: "。", isMatch: false)])
        XCTAssertEqual(LeoMatchHighlight.plainText(markedText: "a【b】c"), "abc")
    }

    func testUnbalancedAndEmptyMarkersStayLiteral() {
        XCTAssertEqual(LeoMatchHighlight.segments(markedText: "前文【没有闭合"),
                       [Seg(text: "前文【没有闭合", isMatch: false)])
        XCTAssertEqual(LeoMatchHighlight.segments(markedText: "孤立】括号"),
                       [Seg(text: "孤立】括号", isMatch: false)])
        XCTAssertEqual(LeoMatchHighlight.segments(markedText: "空【】标记"),
                       [Seg(text: "空【】标记", isMatch: false)])
        // 嵌套:外层的【当普通字,内层成对的才算命中。
        XCTAssertEqual(LeoMatchHighlight.segments(markedText: "【外【内】"),
                       [Seg(text: "【外", isMatch: false), Seg(text: "内", isMatch: true)])
        XCTAssertEqual(LeoMatchHighlight.segments(markedText: ""), [])
    }

    func testMarkedMatchAtEdgesAndAdjacent() {
        XCTAssertEqual(LeoMatchHighlight.segments(markedText: "【开头】中间【结尾】"),
                       [Seg(text: "开头", isMatch: true), Seg(text: "中间", isMatch: false), Seg(text: "结尾", isMatch: true)])
        XCTAssertEqual(LeoMatchHighlight.segments(markedText: "【一】【二】"),
                       [Seg(text: "一", isMatch: true), Seg(text: "二", isMatch: true)])
    }

    func testAttributedStringMarksOnlyMatchRanges() {
        let attributed = LeoMatchHighlight.attributed(LeoMatchHighlight.segments(markedText: "检索【预算】与【Budget】"))
        XCTAssertEqual(String(attributed.characters), "检索预算与Budget")
        XCTAssertEqual(LeoMatchHighlight.matchedTexts(in: attributed), ["预算", "Budget"])
    }

    func testTermHighlightIsCaseInsensitiveAndMergesOverlaps() {
        let segs = LeoMatchHighlight.segments(text: "SwiftUI and swift charts", terms: ["swift"])
        XCTAssertEqual(segs, [Seg(text: "Swift", isMatch: true), Seg(text: "UI and ", isMatch: false),
                              Seg(text: "swift", isMatch: true), Seg(text: " charts", isMatch: false)])
        let merged = LeoMatchHighlight.segments(text: "知识卡片管理", terms: ["知识卡", "卡片"])
        XCTAssertEqual(merged, [Seg(text: "知识卡片", isMatch: true), Seg(text: "管理", isMatch: false)])
        XCTAssertEqual(LeoMatchHighlight.segments(text: "没有命中", terms: ["xyz"]),
                       [Seg(text: "没有命中", isMatch: false)])
        XCTAssertEqual(LeoMatchHighlight.segments(text: "abc", terms: ["  "]), [Seg(text: "abc", isMatch: false)])
    }

    func testQueryTermsDropFilterTokens() {
        XCTAssertEqual(LeoMatchHighlight.terms(fromQuery: "预算 kind:link #工作  报告"), ["预算", "报告"])
        XCTAssertEqual(LeoMatchHighlight.terms(fromQuery: "   "), [])
    }

    // MARK: Adaptive columns

    func testPhoneWidthsAreSingleColumnWith16ptInset() {
        for width in [CGFloat(320), 375, 393, 402, 440] {
            XCTAssertEqual(TreasuryGridLayout.columns(forWidth: width), 1, "width \(width)")
            XCTAssertEqual(TreasuryGridLayout.horizontalInset(forWidth: width), 16, "width \(width)")
        }
    }

    func testWideContainersCenterContentAndUseTwoColumns() {
        XCTAssertEqual(TreasuryGridLayout.columns(forWidth: 700), 2)
        XCTAssertEqual(TreasuryGridLayout.columns(forWidth: 1366), 2)
        XCTAssertEqual(TreasuryGridLayout.contentWidth(forWidth: 1366), TreasuryGridLayout.maxContentWidth)
        XCTAssertEqual(TreasuryGridLayout.horizontalInset(forWidth: 1000), 120)
        // 两列刚好放得下的边界:内容 = 2×300 + 12。
        XCTAssertEqual(TreasuryGridLayout.columns(forWidth: 612 + 32), 2)
        XCTAssertEqual(TreasuryGridLayout.columns(forWidth: 611 + 32), 1)
    }

    func testDegenerateWidthsFallBackToOneColumn() {
        XCTAssertEqual(TreasuryGridLayout.columns(forWidth: 0), 1)
        XCTAssertEqual(TreasuryGridLayout.columns(forWidth: .infinity), 1)
        XCTAssertEqual(TreasuryGridLayout.columns(forWidth: .nan), 1)
        XCTAssertEqual(TreasuryGridLayout.horizontalInset(forWidth: .nan), 16)
    }

    func testRowsChunkByColumnCount() {
        XCTAssertEqual(TreasuryGridLayout.rows([1, 2, 3, 4, 5], columns: 2), [[1, 2], [3, 4], [5]])
        XCTAssertEqual(TreasuryGridLayout.rows([1, 2], columns: 0), [[1], [2]])
        XCTAssertEqual(TreasuryGridLayout.rows([Int](), columns: 2), [])
    }

    // MARK: Stagger cap

    func testStaggerOnlyAnimatesFirstEightRows() {
        XCTAssertTrue(LeoStaggerPolicy.animates(index: 0))
        XCTAssertTrue(LeoStaggerPolicy.animates(index: 7))
        XCTAssertFalse(LeoStaggerPolicy.animates(index: 8))
        XCTAssertFalse(LeoStaggerPolicy.animates(index: 500))
        XCTAssertFalse(LeoStaggerPolicy.animates(index: -1))
        XCTAssertEqual(LeoStaggerPolicy.delay(index: 7), 0.28, accuracy: 0.0001)
        XCTAssertEqual(LeoStaggerPolicy.delay(index: 8), 0)
    }

    func testStaggerIndicesCoverOnlyTheCap() {
        let ids = (0..<30).map { "id\($0)" }
        let map = LeoStaggerPolicy.indices(for: ids)
        XCTAssertEqual(map.count, LeoStaggerPolicy.cap)
        XCTAssertEqual(map["id0"], 0)
        XCTAssertEqual(map["id7"], 7)
        XCTAssertNil(map["id8"])
    }

    // MARK: Type icons

    func testFileKindIcons() {
        XCTAssertEqual(BrainFileKindIcon.symbol(path: "合同/2026.PDF"), "doc.richtext")
        XCTAssertEqual(BrainFileKindIcon.symbol(path: "notes/a.md"), "doc.plaintext")
        XCTAssertEqual(BrainFileKindIcon.symbol(path: "q3.xlsx"), "tablecells")
        XCTAssertEqual(BrainFileKindIcon.symbol(path: nil), "doc.text")
        XCTAssertEqual(BrainFileKindIcon.symbol(path: "noext"), "doc.text")
        XCTAssertEqual(BrainFileKindIcon.symbol(path: "x.pdf", isCard: true), "rectangle.on.rectangle.angled")
    }
}
