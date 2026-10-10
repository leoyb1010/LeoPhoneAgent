#!/usr/bin/env python3
"""Hostile-server tests for the MCP daemon / HTTP transport / CLI.

Run: python3 test_daemon_hardening.py  (stdlib unittest, no deps)

A misbehaving MCP server must not stall a turn, grow memory without bound, kill
the reader thread, or have its in-band error read as a successful result.
"""

import contextlib
import io
import json
import os
import sys
import time
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from transport import http  # noqa: E402
from transport.http import MCPError  # noqa: E402
import daemon  # noqa: E402
import main  # noqa: E402


class _Stdout:
    """Line source with readline(size) semantics like a text-mode pipe."""

    def __init__(self, lines):
        self._buf = "".join(lines)

    def readline(self, size=-1):
        if not self._buf:
            return ""
        end = self._buf.find("\n")
        end = len(self._buf) if end < 0 else end + 1
        if 0 <= size < end:
            end = size
        line, self._buf = self._buf[:end], self._buf[end:]
        return line


class _Proc:
    def __init__(self, lines):
        self.stdout = _Stdout(lines)
        self.stdin = types.SimpleNamespace(write=lambda _: None, flush=lambda: None)

    def poll(self):
        return None


def _server(lines):
    srv = daemon.MCPServerProcess("hostile", {"command": "x"})
    srv.proc = _Proc(lines)
    srv._id = 0  # next id -> 1
    return srv


class ReplyParsingTests(unittest.TestCase):
    def test_reply_id_type_mismatch_times_out_fast(self):
        # The server echoes our numeric id 1 as the string "1". Before, the
        # reader skipped it and the call hung for the full RPC timeout (then
        # retried: ~10 minutes). Now it is matched at once.
        srv = _server(['{"jsonrpc":"2.0","id":"1","result":{"tools":[]}}\n'])
        start = time.time()
        result = srv._rpc("tools/list", timeout=30)
        self.assertEqual(result, {"tools": []})
        self.assertLess(time.time() - start, 1.0)

    def test_non_object_json_line_ignored(self):
        # Arrays / numbers / strings used to raise AttributeError inside the
        # reader thread, which died and surfaced as a fake STDIO_CRASH.
        srv = _server([
            "[1,2,3]\n", "42\n", '"hello"\n', "null\n", "not json\n",
            '{"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n',
            '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n',
        ])
        self.assertEqual(srv._rpc("tools/list", timeout=5), {"ok": True})

    def test_server_request_with_same_id_is_not_taken_as_reply(self):
        srv = _server([
            '{"jsonrpc":"2.0","id":1,"method":"sampling/createMessage","params":{}}\n',
            '{"jsonrpc":"2.0","id":1,"result":{"real":true}}\n',
        ])
        self.assertEqual(srv._rpc("tools/list", timeout=5), {"real": True})

    def test_non_dict_error_member_is_reported(self):
        srv = _server(['{"jsonrpc":"2.0","id":1,"error":"boom"}\n'])
        with self.assertRaises(MCPError) as ctx:
            srv._rpc("tools/list", timeout=5)
        self.assertEqual(ctx.exception.code, "MCP_ERROR")
        self.assertIn("boom", ctx.exception.message)

    def test_oversized_line_aborts(self):
        orig = daemon.MAX_LINE_CHARS
        daemon.MAX_LINE_CHARS = 1024
        try:
            srv = _server(["x" * 5000])  # no newline, far past the limit
            with self.assertRaises(MCPError) as ctx:
                srv._rpc("tools/call", {"name": "t"}, timeout=5)
        finally:
            daemon.MAX_LINE_CHARS = orig
        self.assertEqual(ctx.exception.code, "RESPONSE_TOO_LARGE")


class PoolPolicyTests(unittest.TestCase):
    def _pool_with(self, session):
        pool = daemon.MCPPool(on_empty=lambda: None)
        evicted = []
        pool.get = lambda name: session
        pool.evict = lambda name: evicted.append(name)
        return pool, evicted

    def test_call_timeout_is_not_retried_and_evicts(self):
        calls = []

        class S:
            def call_tool(self, tool, args):
                calls.append(tool)
                raise MCPError("TIMEOUT", "no reply")

        pool, evicted = self._pool_with(S())
        with self.assertRaises(MCPError) as ctx:
            pool.call_with_retry("srv", lambda s: s.call_tool("t", {}), retry_timeout=False)
        self.assertEqual(ctx.exception.code, "TIMEOUT")
        self.assertEqual(len(calls), 1, "tools/call must not be re-sent after a timeout")
        self.assertEqual(evicted, ["srv"], "a timed-out session is not reused")

    def test_oversized_reply_evicts_without_retry(self):
        calls = []

        class S:
            def list_tools(self):
                calls.append(1)
                raise MCPError("RESPONSE_TOO_LARGE", "too big")

        pool, evicted = self._pool_with(S())
        with self.assertRaises(MCPError):
            pool.call_with_retry("srv", lambda s: s.list_tools())
        self.assertEqual(len(calls), 1)
        self.assertEqual(evicted, ["srv"])

    def test_rpc_timeout_is_two_minutes(self):
        self.assertEqual(daemon.RPC_TIMEOUT, 120.0)
        self.assertEqual(http.TIMEOUT_SECONDS, 120)


class ResultCapTests(unittest.TestCase):
    def test_call_tool_result_over_limit_is_truncated(self):
        big = "a" * (6 * 1024 * 1024)
        result = {"content": [{"type": "text", "text": big},
                              {"type": "image", "data": "B" * (1024 * 1024), "mimeType": "image/png"}],
                  "structuredContent": {"echo": big}}

        class S:
            def call_tool(self, tool, args):
                return result

        server = daemon.DaemonServer("/nonexistent/port", "/nonexistent/pid")
        server.pool.get = lambda name: S()
        resp = server.handle_request({"cmd": "call", "server": "srv", "tool": "t", "args": {}})
        self.assertTrue(resp["ok"])
        capped = resp["result"]["result"]
        self.assertTrue(capped.get("truncated"))
        self.assertLessEqual(len(json.dumps(capped, ensure_ascii=False)), daemon.MAX_RESULT_CHARS)
        self.assertIn("truncated by leophoneagent-mcp-cli", capped["content"][0]["text"])
        self.assertNotIn("structuredContent", capped)
        self.assertEqual(capped["content"][1]["data"], "")

    def test_small_result_passes_through_unchanged(self):
        small = {"content": [{"type": "text", "text": "hi"}]}
        self.assertIs(daemon.cap_tool_result(small), small)


class _FakeStreamResp:
    def __init__(self, status, headers, chunks):
        self.status_code = status
        self.headers = headers
        self._chunks = chunks

    def iter_bytes(self):
        for c in self._chunks:
            yield c


class _FakeHTTPX(types.ModuleType):
    class HTTPError(Exception):
        pass

    class TimeoutException(HTTPError):
        pass

    def __init__(self, resp):
        super().__init__("httpx")
        self._resp = resp

    def stream(self, method, url, **kwargs):
        resp = self._resp

        @contextlib.contextmanager
        def cm():
            yield resp
        return cm()


class HTTPCapTests(unittest.TestCase):
    def _transport(self, resp):
        orig = http.httpx
        http.httpx = _FakeHTTPX(resp)
        self.addCleanup(setattr, http, "httpx", orig)
        return http.HTTPTransport({"url": "https://mcp.example.invalid/mcp"}, "srv")

    def test_http_body_over_limit_aborts(self):
        chunk = b"x" * (1024 * 1024)
        t = self._transport(_FakeStreamResp(200, {"content-type": "application/json"}, [chunk] * 5))
        with self.assertRaises(MCPError) as ctx:
            t._post("tools/call", {"name": "t"})
        self.assertEqual(ctx.exception.code, "RESPONSE_TOO_LARGE")

    def test_http_declared_length_over_limit_aborts_before_reading(self):
        t = self._transport(_FakeStreamResp(200, {"content-type": "application/json",
                                                  "content-length": str(50 * 1024 * 1024)}, []))
        with self.assertRaises(MCPError) as ctx:
            t._post("tools/call", {"name": "t"})
        self.assertEqual(ctx.exception.code, "RESPONSE_TOO_LARGE")

    def test_http_small_body_and_string_error(self):
        body = b'{"jsonrpc":"2.0","id":1,"error":["not","a","dict"]}'
        t = self._transport(_FakeStreamResp(200, {"content-type": "application/json"}, [body]))
        with self.assertRaises(MCPError) as ctx:
            t._post("tools/list")
        self.assertEqual(ctx.exception.code, "MCP_ERROR")


class CLIExitTests(unittest.TestCase):
    def _run_call(self, inner):
        orig = main.call_daemon
        main.call_daemon = lambda request, pretty: {"server": "srv", "tool": "t", "result": inner}
        out = io.StringIO()
        code = 0
        try:
            with contextlib.redirect_stdout(out):
                main.cmd_call(["srv", "t"], False)
        except SystemExit as exc:
            code = exc.code
        finally:
            main.call_daemon = orig
        return code, out.getvalue()

    def test_call_isError_sets_nonzero_exit(self):
        orig_log = main._log
        main._log = lambda msg: None
        try:
            code, out = self._run_call({"content": [{"type": "text", "text": "quota exceeded"}], "isError": True})
        finally:
            main._log = orig_log
        self.assertEqual(code, 1)
        envelope = json.loads(out)
        self.assertEqual(envelope["code"], "TOOL_ERROR")
        self.assertEqual(envelope["error"], "quota exceeded")
        self.assertEqual(envelope["server"], "srv")

    def test_call_success_exits_zero(self):
        code, out = self._run_call({"content": [{"type": "text", "text": "ok"}]})
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["result"]["content"][0]["text"], "ok")


if __name__ == "__main__":
    unittest.main(verbosity=2)
