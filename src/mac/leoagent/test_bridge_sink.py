"""Mac bridge push sink (server.py MacBridgeEventSink): what leaves leoagent for the phone."""
import time
import unittest

from .server import MacBridgeEventSink


class MacBridgeEventSinkTests(unittest.TestCase):
    def test_slim_drops_raw_input_and_caps_long_fields(self):
        sink = MacBridgeEventSink("http://127.0.0.1:9/x", "k")
        sink.push({"event": "approval.request", "session_id": "hs_1", "seq": 3, "approval_id": "ap",
                   "tool": "Write", "command": "Write", "description": "写" * 90_000,
                   "raw": {"input": {"content": "文件内容" * 50_000}}})
        queued = sink._outbox[0]
        self.assertNotIn("raw", queued)
        self.assertEqual(queued["tool"], "Write")
        self.assertEqual(len(queued["description"]), MacBridgeEventSink.FIELD_LIMIT)
        self.assertLess(len(repr(queued)), 8_000)

    def test_only_pushable_events_are_queued(self):
        sink = MacBridgeEventSink("http://127.0.0.1:9/x", "k")
        sink.push({"event": "message.delta", "delta": "x"})
        self.assertEqual(sink._outbox, [])

    def test_old_events_are_dropped_before_sending(self):
        sink = MacBridgeEventSink("http://127.0.0.1:9/x", "k")
        sink.push({"event": "run.completed", "session_id": "hs_old", "output": "done"})
        sink.push({"event": "run.completed", "session_id": "hs_new", "output": "done"})
        sink._outbox[0]["_queued_at"] = time.time() - MacBridgeEventSink.MAX_AGE_S - 1
        self.assertEqual(sink._next()["session_id"], "hs_new")
        self.assertEqual(len(sink._outbox), 1)
        sink._outbox[0]["_queued_at"] = time.time() - MacBridgeEventSink.MAX_AGE_S - 1
        self.assertIsNone(sink._next())


if __name__ == "__main__":
    unittest.main()
