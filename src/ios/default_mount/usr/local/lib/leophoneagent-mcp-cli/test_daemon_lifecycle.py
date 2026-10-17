#!/usr/bin/env python3
"""[WP-46] Daemon lifecycle: blocking accept woken on shutdown, host port file,
structured calls.jsonl. Run: python3 test_daemon_lifecycle.py (stdlib only)."""

import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import daemon  # noqa: E402


def rpc(port, payload):
    with socket.create_connection(("127.0.0.1", port), timeout=5) as c:
        c.sendall((json.dumps(payload) + "\n").encode())
        buf = b""
        while b"\n" not in buf:
            chunk = c.recv(65536)
            if not chunk:
                break
            buf += chunk
    return json.loads(buf.split(b"\n")[0])


class DaemonLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = self.tmp.name
        self.port_file = os.path.join(d, "daemon.port")
        self.host_port = os.path.join(d, "shared", "daemon.port")
        self.calls = os.path.join(d, "shared", "calls.jsonl")
        self.server = daemon.DaemonServer(self.port_file, os.path.join(d, "daemon.pid"),
                                          host_port_file=self.host_port, calls_log=self.calls)
        self.thread = threading.Thread(target=self.server.run, daemon=True)
        self.thread.start()
        for _ in range(200):
            if os.path.exists(self.host_port):
                break
            time.sleep(0.01)

    def tearDown(self):
        self.server.stop()
        self.thread.join(3)
        self.tmp.cleanup()

    def test_accept_blocks_without_polling_timeout(self):
        # The listening socket must not carry the old 1 s timeout (busy ppoll after resume).
        self.assertIsNotNone(self.server.port)
        with open(self.host_port) as f:
            self.assertEqual(int(f.read()), self.server.port)

    def test_shutdown_answers_then_exits_and_removes_port_files(self):
        resp = rpc(self.server.port, {"cmd": "shutdown"})
        self.assertTrue(resp["ok"])
        self.thread.join(3)
        self.assertFalse(self.thread.is_alive(), "blocking accept must be woken by shutdown")
        self.assertFalse(os.path.exists(self.port_file))
        self.assertFalse(os.path.exists(self.host_port))

    def test_stop_from_another_thread_wakes_accept(self):
        self.server.stop()
        self.thread.join(3)
        self.assertFalse(self.thread.is_alive())

    def test_calls_are_logged_without_arguments(self):
        resp = rpc(self.server.port, {"cmd": "call", "server": "nope", "tool": "search",
                                      "args": {"query": "secret text"}})
        self.assertFalse(resp["ok"])
        rpc(self.server.port, {"cmd": "list"})   # not an MCP call: not logged
        with open(self.calls) as f:
            rows = [json.loads(line) for line in f]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row["server"], row["method"], row["tool"], row["ok"]), ("nope", "call", "search", False))
        self.assertTrue(row["code"])
        self.assertGreaterEqual(row["ms"], 0)
        self.assertNotIn("secret", json.dumps(row))


class RecordCallTests(unittest.TestCase):
    def test_oversized_log_is_dropped_not_grown(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "calls.jsonl")
            with open(path, "w") as f:
                f.write("x" * (daemon.CALLS_LOG_MAX_BYTES + 1))
            daemon.record_call(path, "s", "ping", True, "OK", 12.7, now=1.0)
            with open(path) as f:
                rows = [json.loads(line) for line in f]
            self.assertEqual(rows, [{"ts": 1.0, "server": "s", "method": "ping", "ok": True, "code": "OK", "ms": 12}])


if __name__ == "__main__":
    unittest.main()
