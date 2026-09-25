"""Approvals the Mac service answers for the phone (harness.py)."""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

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


if __name__ == "__main__":
    unittest.main()
