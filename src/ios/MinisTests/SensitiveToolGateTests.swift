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

    /// 截断复用:授权键取完整命令的 SHA-256,不再是前 160 字符。
    /// 否则模型拿到一条 ≥160 字符良性命令的「本会话允许」后,
    /// 追加 `; rm -rf ~` 就能免审批执行。
    func testRemoteShellScopeIsNotTruncatable() {
        let benign = String(repeating: "echo hello; ", count: 40)   // 远超 160 字符
        XCTAssertGreaterThan(benign.count, 160)
        let a = SensitiveToolGate.Category.grantScope(
            tool: "remote_shell", args: ["host": "studio", "command": benign])
        let b = SensitiveToolGate.Category.grantScope(
            tool: "remote_shell", args: ["host": "studio", "command": benign + "; rm -rf ~"])
        XCTAssertNotEqual(a, b)
    }

    /// remote_agent 实际执行 `zsh -lc 'cd <workdir> && ...'`,
    /// 换 workdir 就是另一件事,不能复用同一条授权。
    func testRemoteAgentScopeIncludesWorkdir() {
        let base: [String: Any] = ["host": "studio", "prompt": "run the tests"]
        let noDir = SensitiveToolGate.Category.grantScope(tool: "remote_agent", args: base)
        var withDir = base
        withDir["workdir"] = "~/secret-repo"
        let dirA = SensitiveToolGate.Category.grantScope(tool: "remote_agent", args: withDir)
        withDir["workdir"] = "~/other-repo"
        let dirB = SensitiveToolGate.Category.grantScope(tool: "remote_agent", args: withDir)
        XCTAssertNotEqual(noDir, dirA)
        XCTAssertNotEqual(dirA, dirB)
    }

    /// 拼接歧义不能撞成同一个哈希。
    func testRemoteAgentScopeSeparatesWorkdirFromPrompt() {
        let a = SensitiveToolGate.Category.grantScope(
            tool: "remote_agent", args: ["host": "h", "workdir": "ab", "prompt": "c"])
        let b = SensitiveToolGate.Category.grantScope(
            tool: "remote_agent", args: ["host": "h", "workdir": "a", "prompt": "bc"])
        XCTAssertNotEqual(a, b)
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

    /// 锁屏 / Siri 派发时 agent 循环必须还能跑:本机 shell 与写文件
    /// 不能后台硬拒,否则「手机休眠后任务继续执行」直接失效。
    func testLocalExecutionIsNotHardDeniedInBackground() {
        XCTAssertEqual(SensitiveToolGate.Category.shell.backgroundPolicy, .notifyAndWait)
        XCTAssertEqual(SensitiveToolGate.Category.fileWrite.backgroundPolicy, .notifyAndWait)
    }

    /// 凭证读写与远程执行是高危低频动作,后台仍然硬拒。
    func testCredentialAndRemoteCategoriesStayHardDeniedInBackground() {
        for category: SensitiveToolGate.Category in
            [.readCredentials, .writeCredentials, .remoteShell, .remoteAgent] {
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
