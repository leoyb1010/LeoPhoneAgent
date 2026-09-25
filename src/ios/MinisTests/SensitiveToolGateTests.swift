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

    // MARK: - [T-gate-scope] 授权范围

    /// 本机 shell / 文件写是会话级授权:点一次「本会话允许」覆盖整轮任务。
    /// 按命令逐条授权在真实任务里等于要点几十次。
    func testLocalShellAndFileWriteShareOneSessionGrant() {
        let a = SensitiveToolGate.Category.grantScope(
            tool: "shell_execute", args: ["command": "ls /tmp"])
        let b = SensitiveToolGate.Category.grantScope(
            tool: "shell_execute", args: ["command": "python3 build.py"])
        XCTAssertEqual(a, b)

        let f1 = SensitiveToolGate.Category.grantScope(
            tool: "file_write", args: ["path": "/var/minis/workspace/a.py"])
        let f2 = SensitiveToolGate.Category.grantScope(
            tool: "file_edit", args: ["path": "/var/minis/workspace/b.py"])
        XCTAssertEqual(f1, f2)
        XCTAssertNotEqual(a, f1)
    }

    /// 远程也按会话授权:「本次会话允许」之后,同一台主机的下一条命令不再问;
    /// 换一台主机、或本机 shell,还是各问各的。
    func testRemoteSessionGrantCoversTheHost() {
        let ls = SensitiveToolGate.Category.grantScope(
            tool: "remote_shell", args: ["host": "studio", "command": "ls"])
        let build = SensitiveToolGate.Category.grantScope(
            tool: "remote_shell", args: ["host": "studio", "command": "make release"])
        let otherHost = SensitiveToolGate.Category.grantScope(
            tool: "remote_shell", args: ["host": "mini", "command": "ls"])
        let local = SensitiveToolGate.Category.grantScope(
            tool: "shell_execute", args: ["command": "ls"])
        XCTAssertEqual(ls, build)
        XCTAssertNotEqual(ls, otherHost)
        XCTAssertNotEqual(ls, local)

        let agentA = SensitiveToolGate.Category.grantScope(
            tool: "remote_agent", args: ["host": "studio", "workdir": "~/a", "prompt": "run the tests"])
        let agentB = SensitiveToolGate.Category.grantScope(
            tool: "remote_agent", args: ["host": "studio", "workdir": "~/b", "prompt": "fix the build"])
        XCTAssertEqual(agentA, agentB)
        XCTAssertNotEqual(agentA, ls)
    }

    /// 远程主机名大小写/空白不同不该产生两条授权。
    func testRemoteScopeNormalizesHost() {
        let a = SensitiveToolGate.Category.grantScope(
            tool: "remote_shell", args: ["host": " Studio ", "command": "ls"])
        let b = SensitiveToolGate.Category.grantScope(
            tool: "remote_shell", args: ["host": "studio", "command": "ls"])
        XCTAssertEqual(a, b)
    }

    // MARK: - [T-gate-bg-policy] 后台策略分级

    /// 锁屏 / Siri 派发时 agent 循环必须还能跑:本机和远程的命令、写文件
    /// 都发通知等批准,不后台硬拒,否则「手机休眠后任务继续执行」直接失效。
    func testExecutionIsNotHardDeniedInBackground() {
        for category: SensitiveToolGate.Category in [.shell, .fileWrite, .remoteShell, .remoteAgent] {
            XCTAssertEqual(category.backgroundPolicy, .notifyAndWait, "\(category.rawValue)")
        }
    }

    /// 浏览器凭证读写后台仍然硬拒(要前台的页面)。
    func testCredentialCategoriesStayHardDeniedInBackground() {
        for category: SensitiveToolGate.Category in [.readCredentials, .writeCredentials] {
            XCTAssertEqual(category.backgroundPolicy, .denyImmediately, "\(category.rawValue)")
        }
    }

    /// 拒绝原因决定回给模型的话术:后台硬拒 / 等待超时 / 用户说不,三种不同。
    func testDenialMessagesAreDistinctPerReason() {
        let bg = SensitiveToolGate.denialMessage(
            .deniedInBackground, category: .readCredentials, host: "example.com")
        let timeout = SensitiveToolGate.denialMessage(
            .deniedByTimeout, category: .shell, host: "ls")
        let user = SensitiveToolGate.denialMessage(
            .deniedByUser, category: .shell, host: "ls")
        XCTAssertNotEqual(bg, timeout)
        XCTAssertNotEqual(bg, user)
        XCTAssertNotEqual(timeout, user)
        XCTAssertTrue(user.contains("用户拒绝"))
    }
}
