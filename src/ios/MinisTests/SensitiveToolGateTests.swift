import XCTest

final class SensitiveToolGateTests: XCTestCase {
    func testRemoteToolsRequireDedicatedApprovalCategories() {
        XCTAssertEqual(SensitiveToolGate.Category.forToolName("remote_shell"), .remoteShell)
        XCTAssertEqual(SensitiveToolGate.Category.forToolName("remote_agent"), .remoteAgent)
    }

    func testRemoteApprovalKeyBindsHostAndExactOperation() {
        let first = SensitiveToolGate.Category.hostHint(
            tool: "remote_shell",
            args: ["host": "studio", "command": "rm -rf /tmp/a"]
        )
        let second = SensitiveToolGate.Category.hostHint(
            tool: "remote_shell",
            args: ["host": "mini", "command": "rm -rf /tmp/a"]
        )
        let third = SensitiveToolGate.Category.hostHint(
            tool: "remote_shell",
            args: ["host": "studio", "command": "rm -rf /tmp/b"]
        )
        XCTAssertNotEqual(first, second)
        XCTAssertNotEqual(first, third)
    }
}
