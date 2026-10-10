import Foundation
import XCTest

final class SessionTitleTests: XCTestCase {

    func testLLMTitleIsSanitized() {
        XCTAssertEqual(SessionTitleSanitizer.generated("## **Debug Login Page**\nSecond line\n\n- more"), "Debug Login Page")
        XCTAssertEqual(SessionTitleSanitizer.generated("```\nTitle: “修复登录页”\n```"), "修复登录页")
        XCTAssertEqual(SessionTitleSanitizer.generated("\"Plan a trip\""), "Plan a trip")
        let long = SessionTitleSanitizer.generated(String(repeating: "word ", count: 2_000) + "\n" + String(repeating: "x", count: 4_096))
        XCTAssertNotNil(long)
        XCTAssertLessThanOrEqual(long?.count ?? 0, SessionTitleSanitizer.maxGeneratedLength)
        XCTAssertFalse(long?.contains("\n") ?? true)
        XCTAssertNil(SessionTitleSanitizer.generated("   \n```\n```"))
        XCTAssertNil(SessionTitleSanitizer.generated("**  **"))
        // Category: fixed list only.
        XCTAssertEqual(SessionTitleSanitizer.category(" Code "), "code")
        XCTAssertNil(SessionTitleSanitizer.category("<script>"))
        XCTAssertNil(SessionTitleSanitizer.category(nil))
    }

    func testUpdateSessionTitleCapsLength() {
        let stored = SessionTitleSanitizer.stored("a\nb\r\n\tc\u{0}d" + String(repeating: "长", count: 50_000))
        XCTAssertFalse(stored.contains("\n"))
        XCTAssertFalse(stored.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) })
        XCTAssertLessThanOrEqual(stored.count, SessionTitleSanitizer.maxStoredLength)
        XCTAssertTrue(stored.hasPrefix("a b c d"))
        XCTAssertEqual(SessionTitleSanitizer.stored("  Normal title  "), "Normal title")
        XCTAssertEqual(SessionTitleSanitizer.stored("🤖 sub agent"), "🤖 sub agent")
    }
}
