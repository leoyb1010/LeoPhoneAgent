"""优雅停机与日志时间戳:launchd 的 ExitTimeOut 只有 5 s,停机要在这之内关完 Mac 通道并落盘。"""

import asyncio
import contextlib
import io
import json
import os
import re
import tempfile
import time
import unittest
from unittest import mock

try:
    import aiohttp
    from aiohttp import WSMsgType
    from aiohttp.test_utils import TestServer
    HAS_AIOHTTP = True
except ModuleNotFoundError:  # pragma: no cover
    HAS_AIOHTTP = False

MASTER = "server-key-0123456789"
STAMP = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}"


@unittest.skipUnless(HAS_AIOHTTP, "aiohttp not installed")
class RelayShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        from .relay import Relay
        self.relay = Relay(
            MASTER,
            device_keys_path=os.path.join(self.tmp.name, "device-keys.json"),
            treasury_sync_path=os.path.join(self.tmp.name, "treasury.json"),
            treasury_asset_dir=os.path.join(self.tmp.name, "assets"),
        )
        self.server = TestServer(self.relay.build_app())
        await self.server.start_server()
        # 单独的会话:TestClient.close() 会先从客户端这边关掉 ws,测不到服务端发的关闭码。
        self.session = aiohttp.ClientSession()

    async def asyncTearDown(self):
        await self.session.close()
        await self.server.close()
        self.tmp.cleanup()

    async def connect(self, name=None):
        ws = await self.session.ws_connect(self.server.make_url("/relay/agent"))
        if name is not None:
            await ws.send_json({"type": "register", "name": name, "key": MASTER,
                                "info": {"version": "1.15.0", "server": "leophoneagent"}})
            ack = json.loads((await ws.receive(timeout=3)).data)
            self.assertEqual(ack["type"], "registered")
        return ws

    async def test_shutdown_closes_sockets_with_1012_and_persists(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            mac = await self.connect("MacBook")
            mini = await self.connect("Mini")
            anonymous = await self.connect()          # 连上了还没 register
            for _ in range(50):
                if len(self.relay._agent_sockets) == 3:
                    break
                await asyncio.sleep(0.02)
            self.assertEqual(len(self.relay._agent_sockets), 3)

            # 内存里有、盘上没有的排队:停机必须把它写下去。
            item = {"request_id": "req-shutdown", "method": "POST", "path": "harness/sessions",
                    "body": {}, "caller": {}, "queued_at": time.time()}
            self.relay.offline_queue["Offline"] = [item]
            self.assertFalse(os.path.exists(self.relay.queue_path))

            started = time.monotonic()
            await self.server.close()
            elapsed = time.monotonic() - started

        for ws in (mac, mini, anonymous):
            msg = await ws.receive(timeout=3)
            self.assertEqual(msg.type, WSMsgType.CLOSE)
            self.assertEqual(msg.data, 1012)
            self.assertEqual(msg.extra, "service restart")
        self.assertLess(elapsed, 3.0)
        self.assertEqual(self.relay.machines, {})
        self.assertEqual(self.relay._agent_sockets, set())

        with open(self.relay.queue_path, encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual([i["request_id"] for i in saved["offline_queue"]["Offline"]], ["req-shutdown"])
        with open(self.relay.status_path, encoding="utf-8") as f:
            status = json.load(f)
        self.assertEqual(status["machines"], [])
        self.assertEqual(status["queued"], {"Offline": 1})

        lines = out.getvalue().splitlines()
        self.assertTrue(any(line.endswith("[relay] MacBook offline") for line in lines), lines)
        for line in lines:
            self.assertRegex(line, rf"^{STAMP} \[relay\] ")

    async def test_shutdown_without_sockets_still_persists(self):
        self.relay.offline_queue["Offline"] = [{"request_id": "r1", "queued_at": time.time()}]
        await self.server.close()
        with open(self.relay.queue_path, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["offline_queue"]["Offline"][0]["request_id"], "r1")
        self.assertTrue(os.path.exists(self.relay.status_path))

    async def test_online_log_line_has_timestamp(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            ws = await self.connect("MacBook")
            await ws.close()
        self.assertRegex(out.getvalue(), rf"(?m)^{STAMP} \[relay\] MacBook online$")


class RelayLogTests(unittest.TestCase):
    def test_log_prefixes_local_iso_timestamp(self):
        from .relay import log
        with contextlib.redirect_stdout(io.StringIO()) as out:
            log("[relay] hello")
        line = out.getvalue()
        self.assertRegex(line, rf"^{STAMP} \[relay\] hello\n$")

    def test_no_bare_print_left_in_relay(self):
        path = os.path.join(os.path.dirname(__file__), "relay.py")
        with open(path, encoding="utf-8") as f:
            source = f.read()
        calls = re.findall(r"^\s*print\(", source, flags=re.M)
        self.assertEqual(len(calls), 1, "only log() itself may call print()")

    @unittest.skipUnless(HAS_AIOHTTP, "aiohttp not installed")
    def test_main_uses_short_shutdown_timeout_and_timestamps(self):
        from . import relay
        with mock.patch.dict(os.environ, {"RELAY_KEY": ""}), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(relay.main([]), 2)
        self.assertRegex(out.getvalue(), rf"^{STAMP} RELAY_KEY is required")

        with tempfile.TemporaryDirectory() as home, \
                mock.patch.dict(os.environ, {"RELAY_KEY": MASTER, "HOME": home}), \
                mock.patch.object(relay, "DEFAULT_DEVICE_KEYS_PATH", os.path.join(home, "dk.json")), \
                mock.patch.object(relay, "DEFAULT_STATE_PATH", os.path.join(home, "state.json")), \
                mock.patch.object(relay, "DEFAULT_TREASURY_SYNC_PATH", os.path.join(home, "t.json")), \
                mock.patch.object(relay.web, "run_app") as run_app, \
                contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(relay.main(["--port", "18650"]), 0)
        self.assertEqual(run_app.call_args.kwargs["shutdown_timeout"], 3)
        self.assertLess(run_app.call_args.kwargs["shutdown_timeout"], 5)
        self.assertRegex(out.getvalue(), rf"^{STAMP} LeoAgent relay ")


if __name__ == "__main__":
    unittest.main()
