"""Approvals the Mac service answers for the phone (harness.py)."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from . import harness as harness_module
from .harness import HARNESSES, HarnessSession


class _Stdin:
    def __init__(self):
        self.frames = []

    def write(self, data: bytes):
        self.frames.append(json.loads(data.decode("utf-8")))

    async def drain(self):
        pass


class _Process:
    def __init__(self):
        self.stdin = _Stdin()
        self.returncode = None


class HarnessApprovalTests(unittest.IsolatedAsyncioTestCase):
    def session(self, harness="claude"):
        self.tmp = tempfile.TemporaryDirectory()
        s = HarnessSession(session_id="hs_test", spec=HARNESSES[harness], cwd=self.tmp.name,
                           log_path=Path(self.tmp.name) / "log.jsonl")
        s.process = _Process()
        s.status = "waiting_for_approval"
        return s

    def tearDown(self):
        self.tmp.cleanup()

    async def test_allow_for_session_keeps_claude_rules_out_of_project_settings(self):
        s = self.session()
        s.pending_approvals["a1"] = {"request_id": "r1", "raw": {"permission_suggestions": [
            {"type": "addRules", "rules": [{"toolName": "Bash"}], "behavior": "allow",
             "destination": "localSettings"}]}}
        self.assertTrue(await s.respond_to_approval("session", "a1"))
        inner = s.process.stdin.frames[0]["response"]["response"]
        self.assertEqual(inner["behavior"], "allow")
        self.assertEqual([p["destination"] for p in inner["updatedPermissions"]], ["session"])
        self.assertEqual(s.pending_approvals, {})

    async def test_stop_closes_open_approvals(self):
        s = self.session()
        s.process = None  # nothing to signal
        s.pending_approvals["a1"] = {"request_id": "r1"}
        await s.stop()
        events = [json.loads(line) for line in s.log_path.read_text().splitlines()]
        self.assertEqual([e["event"] for e in events], ["approval.responded", "run.cancelled"])
        self.assertEqual(events[0]["choice"], "deny")
        self.assertEqual(s.pending_approvals, {})

    def test_handshake_error_fails_the_turn(self):
        s = self.session("codex")
        s._pending_inputs.append("fix the bug")
        event = s._rpc_error_event({"message": "Not logged in"})
        self.assertEqual(event["event"], "run.failed")
        self.assertEqual(s._pending_inputs, [])
        s._thread_id = "t1"
        self.assertEqual(s._rpc_error_event({"message": "later"})["event"], "harness.stderr")


class _LiveProcess(_Process):
    """A CLI whose stdout the test feeds line by line."""

    def __init__(self):
        super().__init__()
        self.stdout = asyncio.StreamReader()

    def say(self, frame):
        self.stdout.feed_data((json.dumps(frame) + "\n").encode("utf-8"))

    async def wait(self):
        self.returncode = 0
        return 0


class FullAutoTests(unittest.IsolatedAsyncioTestCase):
    """[A1] 全自动:CLI 的每条审批由 Mac 直接答「本会话允许」,手机不出卡、不推送。"""

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pushed = []
        self.previous_sink = harness_module._event_sink
        harness_module.set_event_sink(self.pushed.append)

    async def asyncTearDown(self):
        harness_module.set_event_sink(self.previous_sink)
        for task in getattr(self, "pumps", []):
            task.cancel()
        self.tmp.cleanup()

    def live(self, harness, full_auto=True):
        s = HarnessSession(session_id="hs_auto", spec=HARNESSES[harness], cwd=self.tmp.name,
                           log_path=Path(self.tmp.name) / f"{harness}.jsonl", full_auto=full_auto)
        s.process = _LiveProcess()
        s.status = "running"
        self.pumps = getattr(self, "pumps", []) + [asyncio.create_task(s._pump_stdout())]
        return s

    async def settle(self, s, frames=None, events=None):
        for _ in range(200):
            if frames is not None and len(s.process.stdin.frames) >= frames:
                return
            if events is not None and len(self.events(s)) >= events:
                return
            await asyncio.sleep(0.005)

    @staticmethod
    def events(s):
        if not s.log_path.exists():
            return []
        return [json.loads(line) for line in s.log_path.read_text().splitlines()]

    def assert_auto_answered(self, s, approval_ids):
        events = self.events(s)
        self.assertNotIn("approval.request", [e["event"] for e in events])
        responded = [e for e in events if e["event"] == "approval.responded"]
        self.assertEqual([e["approval_id"] for e in responded], approval_ids)
        for e in responded:
            self.assertEqual(e["choice"], "session")
            self.assertIs(e["auto"], True)
        self.assertEqual(s.pending_approvals, {})
        self.assertNotEqual(s.status, "waiting_for_approval")
        self.assertEqual([e for e in self.pushed if e["event"] == "approval.request"], [])

    async def test_full_auto_answers_claude_approval(self):
        s = self.live("claude")
        s.process.say({"type": "control_request", "request_id": "r1", "request": {
            "subtype": "can_use_tool", "tool_name": "Bash", "input": {"command": "ls"},
            "permission_suggestions": [{"type": "addRules", "rules": [{"toolName": "Bash"}],
                                        "behavior": "allow", "destination": "localSettings"}]}})
        await self.settle(s, frames=1)
        frame = s.process.stdin.frames[0]
        self.assertEqual(frame["type"], "control_response")
        self.assertEqual(frame["response"]["request_id"], "r1")
        inner = frame["response"]["response"]
        self.assertEqual(inner["behavior"], "allow")
        self.assertEqual([p["destination"] for p in inner["updatedPermissions"]], ["session"])
        await self.settle(s, events=1)
        self.assert_auto_answered(s, ["r1"])
        self.assertEqual(self.events(s)[-1]["command"], "Bash")

    async def test_full_auto_answers_codex_exec_and_patch(self):
        s = self.live("codex")
        s.process.say({"jsonrpc": "2.0", "id": 7, "method": "item/commandExecution/requestApproval",
                       "params": {"item": {"command": "npm test"}, "reason": "run tests"}})
        s.process.say({"jsonrpc": "2.0", "id": 8, "method": "item/fileChange/requestApproval",
                       "params": {"item": {}, "reason": "edit a.txt"}})
        await self.settle(s, frames=2)
        answers = [f for f in s.process.stdin.frames if "result" in f]
        self.assertEqual([(f["id"], f["result"]["decision"]) for f in answers],
                         [(7, "acceptForSession"), (8, "acceptForSession")])
        await self.settle(s, events=2)
        self.assert_auto_answered(s, ["7", "8"])

    async def test_full_auto_answers_grok_acp(self):
        s = self.live("grok")
        s.process.say({"jsonrpc": "2.0", "id": 21, "method": "session/request_permission", "params": {
            "toolCall": {"title": "write a.txt", "kind": "edit"},
            "options": [{"optionId": "yes", "kind": "allow_once"},
                        {"optionId": "always", "kind": "allow_always"},
                        {"optionId": "no", "kind": "reject_once"}]}})
        await self.settle(s, frames=1)
        frame = s.process.stdin.frames[0]
        self.assertEqual(frame["id"], 21)
        self.assertEqual(frame["result"]["outcome"], {"outcome": "selected", "optionId": "yes"})
        await self.settle(s, events=1)
        self.assert_auto_answered(s, ["21"])

    async def test_full_auto_off_still_waits(self):
        s = self.live("codex", full_auto=False)
        s.process.say({"jsonrpc": "2.0", "id": 7, "method": "item/commandExecution/requestApproval",
                       "params": {"item": {"command": "rm -rf build"}}})
        await self.settle(s, events=1)
        self.assertEqual(s.process.stdin.frames, [])
        self.assertEqual([e["event"] for e in self.events(s)], ["approval.request"])
        self.assertIn("7", s.pending_approvals)
        self.assertEqual(s.status, "waiting_for_approval")
        self.assertEqual([e["event"] for e in self.pushed], ["approval.request"])

    async def test_full_auto_toggled_off_midway_waits(self):
        s = self.live("claude")
        s.process.say({"type": "control_request", "request_id": "r1",
                       "request": {"subtype": "can_use_tool", "tool_name": "Read"}})
        await self.settle(s, frames=1)
        s.full_auto = False   # 手机关掉全自动(后续消息带 full_auto:false 或 /harness/full-auto)
        s.process.say({"type": "control_request", "request_id": "r2",
                       "request": {"subtype": "can_use_tool", "tool_name": "Bash"}})
        await self.settle(s, events=2)
        self.assertEqual(len(s.process.stdin.frames), 1)
        events = self.events(s)
        self.assertEqual([(e["event"], e.get("approval_id")) for e in events],
                         [("approval.responded", "r1"), ("approval.request", "r2")])
        self.assertIs(events[0]["auto"], True)
        self.assertEqual(list(s.pending_approvals), ["r2"])
        self.assertEqual(s.status, "waiting_for_approval")
        self.assertEqual([e["approval_id"] for e in self.pushed], ["r2"])

    async def test_unroutable_request_falls_back_to_the_phone(self):
        # 没有 request_id 的审批答不到 CLI:照常发给手机,不能假装已允许。
        s = self.live("claude")
        s.process.say({"type": "control_request", "request": {"subtype": "can_use_tool",
                                                              "tool_name": "Bash"}})
        await self.settle(s, events=1)
        self.assertEqual(s.process.stdin.frames, [])
        self.assertEqual([e["event"] for e in self.events(s)], ["approval.request"])


if __name__ == "__main__":
    unittest.main()
