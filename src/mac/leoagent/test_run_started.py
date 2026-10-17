"""[WP-41] leoagent 自己跑的会话也报 run.started,并交给 Mac 桥接推送(中继据此拉起灵动岛)。"""
import asyncio
import json
import tempfile
import unittest
from pathlib import Path

from . import harness as harness_module
from .harness import HARNESSES, PUSHABLE_EVENTS, HarnessSession
from .server import MacBridgeEventSink


class _Stdin:
    def __init__(self):
        self.lines = []

    def write(self, data):
        self.lines.append(data)

    async def drain(self):
        return None


class _Process:
    returncode = None

    def __init__(self):
        self.stdin = _Stdin()


class RunStartedTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.pushed = []
        harness_module.set_event_sink(self.pushed.append)

    def tearDown(self):
        harness_module.set_event_sink(None)
        self.tmp.cleanup()

    def session(self):
        s = HarnessSession(session_id="hs_run", spec=HARNESSES["claude"], cwd=self.tmp.name,
                           log_path=Path(self.tmp.name) / "log.jsonl", phone_session_id="phone-1")
        s.process = _Process()
        s.status = "running"
        return s

    def names(self):
        return [json.loads(line)["event"] for line in
                (Path(self.tmp.name) / "log.jsonl").read_text().splitlines()]

    def test_run_started_once_per_turn_and_again_after_completion(self):
        s = self.session()
        asyncio.run(s.send("第一轮"))
        asyncio.run(s.send("轮中追加"))
        s._emit({"event": "run.completed", "output": "", "usage": {}})
        asyncio.run(s.send("第二轮"))
        self.assertEqual(self.names(), ["user.message", "run.started", "user.message",
                                        "run.completed", "user.message", "run.started"])

    def test_run_started_is_pushable_and_carries_phone_session(self):
        self.assertIn("run.started", PUSHABLE_EVENTS)
        s = self.session()
        asyncio.run(s.send("跑"))
        started = [e for e in self.pushed if e.get("event") == "run.started"]
        self.assertEqual(len(started), 1)
        self.assertEqual(started[0]["phone_session_id"], "phone-1")
        sink = MacBridgeEventSink("http://127.0.0.1:9/x", "k")
        sink.push(started[0])
        self.assertEqual(sink._outbox[0]["event"], "run.started")


if __name__ == "__main__":
    unittest.main()
