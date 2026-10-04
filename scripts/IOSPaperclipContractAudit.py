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
        self.assertEqual(len(source_paths), 7)
        for path in source_paths:
            self.assertIn(f"path = {path.relative_to(IOS)};", project)
            self.assertGreaterEqual(project.count(f"/* {path.name} in Sources */"), 2)
        harness = (ROOT / "scripts/native-paperclip-audit/project.yml").read_text()
        self.assertIn("../../src/ios/Agent/Paperclip", harness)
        self.assertIn("../../src/ios/Views/Paperclip", harness)

    def test_local_stays_default_and_existing_gateway_is_not_rewired(self):
        root = (VIEWS / "PaperclipWorkspaceView.swift").read_text()
        self.assertIn("IOSExecutionBackend.local.rawValue", root)
        self.assertIn("else { localContent() }", root)
        self.assertIn("IOSWorkspaceRootView { ContentView() }", (IOS / "MinisApp.swift").read_text())
        client = (CORE / "PaperclipClient.swift").read_text()
        for forbidden in ["LeoAgentClient", "GatewayHostStore", "ChatStore", "runAgent", "apiKey", 'forHTTPHeaderField: "Authorization"']:
            self.assertNotIn(forbidden, client)

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

    def test_no_secrets_in_profile_or_draft_and_no_automatic_mutation_retry(self):
        contract = (CORE / "PaperclipContract.swift").read_text()
        profile = contract.split("struct PaperclipProfile:")[1].split("struct PaperclipTaskReference:")[0]
        stored = re.findall(r"let\s+(\w+)\s*:", profile)
        self.assertEqual(stored, ["id", "name", "origin"])
        client = (CORE / "PaperclipClient.swift").read_text()
        self.assertNotIn("while ", client)
        self.assertIn("case 500...599 where mutation: throw PaperclipError.uncertain", client)
        self.assertIn('origin == profile.origin', contract)
        self.assertIn('self.userID == userID', contract)

    def test_swift_unit_tests_are_in_test_target_and_native_logs_preserve_failures(self):
        project = (IOS / "LeoPhoneAgent.xcodeproj/project.pbxproj").read_text()
        for source in ["PaperclipContract.swift", "PaperclipClient.swift", "PaperclipDraft.swift"]:
            self.assertEqual(project.count(f"/* {source} in Sources */"), 4)
        for name in ["PaperclipContractTests.swift", "PaperclipClientTests.swift"]:
            self.assertTrue((IOS / "MinisTests" / name).is_file())
        script = (ROOT / "scripts/native-paperclip-audit/run.sh").read_text()
        self.assertIn("set -euo pipefail", script)
        self.assertIn("xcodebuild test", script)
        self.assertIn("exit 2", script)
        self.assertIn("-resultBundlePath", script)

    def test_uncertain_status_sheet_can_only_verify_with_read(self):
        view = (VIEWS / "PaperclipIssueDetailView.swift").read_text()
        self.assertIn("pendingVerification: PaperclipStatusExpectation?", view)
        verify = view.split("func verifyStatus(")[1].split("func record(")[0]
        self.assertIn("client.issue(reference)", verify)
        self.assertIn("expected.matches(current)", verify)
        self.assertNotIn("setStatus(", verify)
        pending = view.split("if let pendingVerification {")[1].split("} else {")[0]
        self.assertIn('"paperclip.verifyStatus"', pending)
        self.assertNotIn("changeStatus(", pending)
        self.assertIn("pendingVerification != nil", view)

    def test_editing_pauses_background_refresh_and_approval_ids_are_local(self):
        view = (VIEWS / "PaperclipIssueDetailView.swift").read_text()
        self.assertIn(".task(id: pollingEnabled)", view)
        self.assertIn("PaperclipPollingPolicy.canRefresh(active: scenePhase == .active, statusSheetOpen: showStatusPicker, replyFocused: isReplyFocused)", view)
        self.assertIn(".focused($isReplyFocused)", view)
        self.assertNotIn('}.accessibilityIdentifier("paperclip.approval.', view)
        self.assertEqual(view.count(".buttonStyle(.borderless)"), 2)

    def test_all_new_visible_literals_are_chinese(self):
        for path in VIEWS.glob("*.swift"):
            for literal in re.findall(r'\b(?:Text|Button|Label|Section|TextField|Picker|ProgressView)\("([^"\\]*)"', path.read_text()):
                if literal:
                    self.assertRegex(literal, r"[\u3400-\u9fff]", f"{path.name}: {literal}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
