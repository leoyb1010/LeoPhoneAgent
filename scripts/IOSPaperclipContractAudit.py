#!/usr/bin/env python3
"""可在 Linux 运行的补充检查；明确不是 Swift 编译或原生运行证明。"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
IOS = ROOT / "src/ios"
CORE = IOS / "Agent/Paperclip"
VIEWS = IOS / "Views/Paperclip"


class IOSPaperclipContractAudit(unittest.TestCase):
    def test_all_new_production_sources_are_app_members_and_native_harness_inputs(self):
        project = (IOS / "LeoPhoneAgent.xcodeproj/project.pbxproj").read_text()
        source_paths = sorted([*CORE.glob("*.swift"), *VIEWS.glob("*.swift")])
        # 14 = 13 + Agent/Paperclip/PaperclipIntents.swift（1.56.0 快捷指令动作，留在边界内）。
        # 15 = 14 + Agent/Paperclip/PaperclipHandoff.swift（1.57.0 对话升级为工单，只收字符串）。
        # 17 = 15 + PaperclipLiveActivity.swift（灵动岛/完成通知）+ PaperclipSpotlightIndexer.swift（G2/G5/G8）。
        self.assertEqual(len(source_paths), 17)
        for path in source_paths:
            self.assertIn(f"path = {path.relative_to(IOS)};", project)
            self.assertGreaterEqual(project.count(f"/* {path.name} in Sources */"), 2)
        harness = (ROOT / "scripts/native-paperclip-audit/project.yml").read_text()
        self.assertIn("../../src/ios/Agent/Paperclip", harness)
        self.assertIn("../../src/ios/Views/Paperclip", harness)

    def test_local_stays_default_and_existing_gateway_is_not_rewired(self):
        root = (VIEWS / "PaperclipWorkspaceView.swift").read_text()
        self.assertIn("IOSExecutionBackend.local.rawValue", root)
        self.assertIn("TabView(selection: $selected)", root)
        self.assertIn("localContent()", root)
        self.assertNotIn(".safeAreaInset(edge: .top", root.split("struct PaperclipBackendSettingsView", 1)[0])
        self.assertIn("IOSWorkspaceRootView { ContentView() }", (IOS / "MinisApp.swift").read_text())
        client = (CORE / "PaperclipClient.swift").read_text()
        for forbidden in ["LeoAgentClient", "GatewayHostStore", "ChatStore", "runAgent", "apiKey", 'forHTTPHeaderField: "Authorization"']:
            self.assertNotIn(forbidden, client)
        # 快捷指令动作只经 PaperclipWorkspaceStore / PaperclipClient，不碰本机对话与网关。
        intents = (CORE / "PaperclipIntents.swift").read_text()
        for forbidden in ["LeoAgentClient", "GatewayHostStore", "ChatStore", "runAgent", "AIChatViewModel", "apiKey"]:
            self.assertNotIn(forbidden, intents)
        # [G3] 对话 → 工单的桥只接收字符串：不引用本机对话、网关与模型。
        handoff = (CORE / "PaperclipHandoff.swift").read_text()
        self.assertIn("static func open(title: String, description: String", handoff)
        for forbidden in ["ChatStore", "Gateway", "AIChatViewModel", "ChatMessage", "LeoAgentClient", "runAgent", "apiKey"]:
            self.assertNotIn(forbidden, handoff)
        create = (VIEWS / "PaperclipWorkspaceView.swift").read_text()
        for forbidden in ["ChatStore", "AIChatViewModel", "GatewayHostStore"]:
            self.assertNotIn(forbidden, create)
        # G2/G5/G8 系统界面同样只依赖 Paperclip 类型与系统框架。
        for name in ["PaperclipLiveActivity.swift", "PaperclipSpotlightIndexer.swift"]:
            surface = (CORE / name).read_text()
            for forbidden in ["LeoAgentClient", "GatewayHostStore", "ChatStore", "runAgent", "AIChatViewModel", "apiKey",
                              "NotificationQuickReply", "BackgroundKeepAliveManager", "AgentLiveActivityManager"]:
                self.assertNotIn(forbidden, surface, name)

    def test_native_auth_has_no_password_collection_or_javascript_cookie_bridge(self):
        client = (CORE / "PaperclipClient.swift").read_text()
        login = (VIEWS / "PaperclipLoginView.swift").read_text()
        store = (CORE / "PaperclipWorkspaceStore.swift").read_text()
        self.assertIn('"/api/auth/get-session"', client)
        self.assertIn("identity.user.id == userID", client)
        self.assertIn("completionHandler(nil)", client)
        self.assertIn("configuration.httpCookieStorage = nil", client)
        self.assertIn("WKWebsiteDataStore(forIdentifier: profile.id)", store)
        self.assertIn('appendingPathComponent("auth")', login)
        for forbidden in ["evaluateJavaScript", "document.cookie", "SecureField", "password:", "accessKey", "apiKey"]:
            self.assertNotIn(forbidden, login)

    def test_contract_uses_real_upstream_endpoints_and_dedup_fields(self):
        client = (CORE / "PaperclipClient.swift").read_text()
        for marker in ['"/api/health"', '"/api/companies?scope=accessible"', '/issues?limit=100&offset=', '/comments?order=asc', '"/runs"', '"/approvals"', '"idempotencyKey"', '"clientRequestId"', '"decisionNote"', 'limitBytes=64000']:
            self.assertIn(marker, client)
        self.assertIn("let runId: String", (CORE / "PaperclipContract.swift").read_text())
        self.assertIn("await issue(ref)", client)
        self.assertIn('approval.status == "pending"', client)
        self.assertIn("current.contains(where: { $0 == approval })", client)

    def test_cancel_mirrors_mac_route_preflight_and_read_reconciliation(self):
        # 上游 POST /api/heartbeat-runs/:runId/cancel（server/src/routes/agents.ts），
        # 与 Mac 端 mutations.ts / reconcile.ts 一致：预检运行属于此任务且在进行，回执可空，用 GET 核实终态。
        client = (CORE / "PaperclipClient.swift").read_text()
        cancel = client.split("func cancel(", 1)[1].split("func runLog(", 1)[0]
        self.assertIn('"/api/heartbeat-runs/\\(id)/cancel", method: "POST"', cancel)
        self.assertIn('"/api/heartbeat-runs/\\(id)", userID', cancel)
        self.assertLess(cancel.index("try await runs(ref)"), cancel.index('method: "POST"'))
        self.assertLess(cancel.index('method: "POST"'), cancel.index("PaperclipRunReceipt"))
        self.assertEqual(cancel.count('method: "POST"'), 1)
        self.assertIn('current == "queued" || current == "running"', cancel)
        self.assertIn("throw PaperclipError.uncertain", cancel)
        contract = (CORE / "PaperclipContract.swift").read_text()
        self.assertIn('["cancelled", "succeeded", "failed", "timed_out"]', contract)

    def test_issue_deep_link_selects_paperclip_not_local(self):
        router = (IOS / "Shared/DeepLinkRouter.swift").read_text()
        case = router.split("case PaperclipDeepLink.host:", 1)[1].split("default:", 1)[0]
        self.assertIn("PaperclipDeepLink.parse(url)", case)
        self.assertIn("IOSExecutionBackend.selectPaperclip()", case)
        self.assertNotIn("selectLocal", case)
        self.assertLess(case.index("PaperclipDeepLink.parse(url)"), case.index("selectPaperclip()"))
        workspace = (VIEWS / "PaperclipWorkspaceView.swift").read_text()
        self.assertIn("NavigationSplitView", workspace)
        self.assertIn("sizeClass == .regular", workspace)
        self.assertIn("PaperclipNavigationInbox.shared", workspace)

    def test_no_secrets_in_profile_or_draft_and_no_automatic_mutation_retry(self):
        contract = (CORE / "PaperclipContract.swift").read_text()
        profile = contract.split("struct PaperclipProfile:")[1].split("struct PaperclipTaskReference:")[0]
        stored = re.findall(r"let\s+(\w+)\s*:", profile)
        self.assertEqual(stored, ["id", "name", "origin"])
        client = (CORE / "PaperclipClient.swift").read_text()
        # 读取已加载列表允许分页循环；只禁止实际请求 IO 自动重试写入。
        request_io = client.split("private func raw(", 1)[1]
        self.assertNotIn("while ", request_io)
        self.assertEqual(request_io.count("session.data(for: request)"), 1)
        self.assertIn("case 500...599 where mutation: throw PaperclipError.uncertain", client)
        self.assertIn('origin == profile.origin', contract)
        self.assertIn('self.userID == userID', contract)

    def test_swift_unit_tests_are_in_test_target_and_native_logs_preserve_failures(self):
        project = (IOS / "LeoPhoneAgent.xcodeproj/project.pbxproj").read_text()
        for source in ["PaperclipContract.swift", "PaperclipClient.swift", "PaperclipDraft.swift",
                       "PaperclipLive.swift", "PaperclipLiveConnection.swift", "PaperclipRunStream.swift"]:
            self.assertEqual(project.count(f"/* {source} in Sources */"), 4)
        for name in ["PaperclipContractTests.swift", "PaperclipClientTests.swift", "PaperclipLiveTests.swift"]:
            self.assertTrue((IOS / "MinisTests" / name).is_file())
        script = (ROOT / "scripts/native-paperclip-audit/run.sh").read_text()
        self.assertIn("set -euo pipefail", script)
        self.assertIn("xcodebuild test", script)
        self.assertIn("exit 2", script)
        self.assertIn("-resultBundlePath", script)

    def test_uncertain_status_sheet_can_only_verify_with_read(self):
        view = (VIEWS / "PaperclipIssueDetailView.swift").read_text()
        self.assertIn("pendingStatus: PaperclipStatusExpectation?", view)
        verify = view.split("func verifyStatus(", 1)[1].split("func refresh(", 1)[0]
        self.assertIn("client.issue(reference)", verify)
        self.assertIn("expected.matches(current)", verify)
        self.assertNotIn("setStatus(", verify)
        self.assertIn('"核实状态（不会重新发送）"', view)
        self.assertIn("model.pendingStatus != nil", view)

    def test_reads_pause_only_for_writes_and_send_releases_focus(self):
        # 新语义：输入框聚焦、面板打开不再暂停只读刷新；只有写请求进行中暂停。
        view = (VIEWS / "PaperclipIssueDetailView.swift").read_text()
        workspace = (VIEWS / "PaperclipWorkspaceView.swift").read_text()
        self.assertIn(".task(id: scenePhase)", view)
        self.assertIn("PaperclipPollingPolicy.canRefresh(active: visible, mutating: model.busy)", view)
        self.assertIn("PaperclipPollingPolicy.canRefresh(active: true, mutating: creating)", workspace)
        self.assertIn("focus: $editingReply", view)
        self.assertIn("editingReply = outcome.keepsComposerFocus", view)
        polling = view.split("private func pollLoop()", 1)[1].split("// MARK: 线程", 1)[0]
        for forbidden in ["draft.body", "decisionNote", "editingReply", "details", "statusDecision"]:
            self.assertNotIn(forbidden, polling)
        # 回到前台先刷新一次，再进入周期。
        self.assertLess(polling.index("await model.refresh(full: true)"), polling.index("Task.sleep"))

    def test_live_channel_keeps_identity_cookie_and_company_isolation(self):
        client = (CORE / "PaperclipClient.swift").read_text()
        live = (CORE / "PaperclipLiveConnection.swift").read_text()
        store = (CORE / "PaperclipWorkspaceStore.swift").read_text()
        handshake = client.split("func liveSocketRequest(", 1)[1].split("static func liveSameOrigin", 1)[0]
        self.assertIn("confirmIdentity(cookies: cookies, userID: userID, fresh: true)", handshake)
        self.assertIn("Self.cookies(cookies, for: httpsURL)", handshake)
        self.assertIn('parts.scheme = "wss"', handshake)
        self.assertIn("Self.liveSameOrigin(url, profile.origin)", handshake)
        self.assertNotIn("Authorization", handshake)
        for marker in ["configuration.httpShouldSetCookies = false", "configuration.httpCookieStorage = nil",
                       "PaperclipNoRedirect()", "event.companyId == companyID", "finish(.protocolViolation)",
                       "PaperclipClient.liveSameOrigin(url, profile.origin)", "identityRefreshInterval: Double = 600"]:
            self.assertIn(marker, live)
        reset = store.split("private func resetConnection()", 1)[1].split("func clearLogin()", 1)[0]
        self.assertIn("stopLive()", reset)
        select_company = store.split("func selectCompany(", 1)[1].split("func refresh(", 1)[0]
        self.assertLess(select_company.index("stopLive()"), select_company.index("companyID = id"))
        self.assertIn("setForeground", store)

    def test_website_handoff_keeps_profile_container_origin_and_health_gate(self):
        login = (VIEWS / "PaperclipLoginView.swift").read_text()
        workspace = (VIEWS / "PaperclipWorkspaceView.swift").read_text()
        self.assertIn('accessibilityIdentifier("paperclip.openWebsite")', workspace)
        self.assertIn("PaperclipWebsiteView(profile: profile)", workspace)
        self.assertIn("onDismiss: { Task { await store.connect() } }", workspace)
        self.assertIn("PaperclipLoginBrowser(profile: profile, workspace: true", login)
        self.assertIn("workspace ? profile.origin : profile.origin.appendingPathComponent", login)
        self.assertIn("websiteData(for: profile)", login)
        self.assertIn("try await client.health()", login)
        self.assertIn("PaperclipProfile.sameOrigin(url, origin)", login)
        self.assertIn("网页公司以网页当前选择为准", login)

    def test_all_new_visible_literals_are_chinese(self):
        for path in VIEWS.glob("*.swift"):
            for literal in re.findall(r'\b(?:Text|Button|Label|Section|TextField|Picker|ProgressView)\("([^"\\]*)"', path.read_text()):
                if literal and any(character.isalpha() for character in literal):
                    self.assertRegex(literal, r"[\u3400-\u9fff]", f"{path.name}: {literal}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
