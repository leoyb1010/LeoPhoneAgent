import asyncio
import json
import os
import signal
import sys
import tempfile
import types
import unittest
import unittest.mock
from pathlib import Path

try:
    import aiohttp  # noqa: F401
except ModuleNotFoundError:
    # The logger is stdlib-only. CI can exercise it without installing the
    # relay network stack; postponed annotations keep web types unevaluated.
    stub = types.ModuleType("aiohttp")
    stub.WSMsgType = object()
    stub.web = types.SimpleNamespace()
    sys.modules["aiohttp"] = stub

from . import relay as relay_module
from .harness import HARNESSES, HarnessSession
from .relay import Machine, Relay
from .relay_client import RelayClient


class RelayRejectedLogTests(unittest.TestCase):
    def test_rejected_token_is_fingerprinted_rate_limited_and_rotated(self):
        canary = "secret-rejected-bearer-0123456789"
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "rejected.log")
            with open(path, "wb") as stream:
                stream.write(b"x" * (64 * 1024))
            relay = Relay("server-key-0123456789", rejected_log=path)
            relay._record_rejected(canary, "/relay/api/machines")
            for _ in range(10_000):
                relay._record_rejected(canary, "/relay/api/machines")

            with open(path, encoding="utf-8") as stream:
                current = stream.read()
            self.assertNotIn(canary, current)
            self.assertIn("hmac=", current)
            self.assertEqual(current.count("\n"), 1)
            self.assertLess(os.path.getsize(path), 1024)
            self.assertTrue(os.path.exists(path + ".1"))


class RelayMachineListTests(unittest.IsolatedAsyncioTestCase):
    """注册方给的 info 不能盖掉中继自己的权威字段。"""

    async def test_registered_info_cannot_override_the_routing_name(self):
        relay = Relay("server-key-0123456789")
        relay.machines["mac-mini"] = Machine(
            "mac-mini", None,
            # 一台机器只要在 info 里带个 name,旧实现(固定字段在前、**info 在后)
            # 就会让列表里显示的名字和真正的路由 key 不一致 —— 配对码带的是这个
            # 假名字,手机拿着它去 /m/{name}/... 永远路由不到。online 同理:
            # 注册方不该有能力宣称自己"离线"或伪造连接时间。
            {"name": "冒名顶替", "online": False, "connected_at": 0,
             "platform": "android", "server": "minis"},
        )
        request = types.SimpleNamespace(
            headers={"Authorization": "Bearer server-key-0123456789"},
            path="/relay/api/machines",
        )
        captured = {}

        def fake_json_response(payload, **_kwargs):
            captured["payload"] = payload
            return payload

        with unittest.mock.patch.object(
                relay_module.web, "json_response", fake_json_response, create=True):
            await relay.list_machines(request)

        machine = captured["payload"]["machines"][0]
        self.assertEqual(machine["name"], "mac-mini")
        self.assertIs(machine["online"], True)
        self.assertGreater(machine["connected_at"], 0)
        # 非权威字段照常透传
        self.assertEqual(machine["platform"], "android")
        self.assertEqual(machine["server"], "minis")


class RelayClientOutboxTests(unittest.IsolatedAsyncioTestCase):
    """一帧发不出去,不能把它后面所有帧一起堵死。"""

    async def test_unserializable_frame_is_dropped_instead_of_blocking_the_queue(self):
        client = RelayClient("https://relay.example/relay/agent", "k" * 16, 38473, "local")
        sent = []

        class FakeWs:
            async def send_json(self, frame):
                # 真实 ws.send_json 对不可序列化的内容抛 TypeError
                json.dumps(frame)
                sent.append(frame)

        client._wake = asyncio.Event()
        client._outbox = [
            {"type": "event", "event": {"bad": object()}},   # 毒药帧
            {"type": "event", "event": {"ok": 1}},
            {"type": "event", "event": {"ok": 2}},
        ]
        client._wake.set()
        sender = asyncio.create_task(client._sender_loop(FakeWs()))
        await asyncio.sleep(0)
        for _ in range(20):
            if not client._outbox:
                break
            await asyncio.sleep(0.01)
        sender.cancel()
        await asyncio.wait({sender})

        # 毒药帧被丢掉,后面的审批/终态/推送照常外推;旧实现会把它留在队首,
        # 之后**所有**外推永久静默。
        self.assertEqual(client._outbox, [])
        self.assertEqual([f["event"] for f in sent], [{"ok": 1}, {"ok": 2}])


class HarnessStopTests(unittest.IsolatedAsyncioTestCase):
    """run.cancelled 必须在进入"等进程退出"之前就落进日志。"""

    def _session(self, tmp):
        return HarnessSession(
            session_id="hs_stop",
            spec=HARNESSES["claude"],
            cwd=tmp,
            log_path=Path(tmp) / "hs_stop.ndjson",
        )

    async def test_cancel_event_lands_before_the_process_wait(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = self._session(tmp)
            session.status = "running"

            class SlowProcess:
                returncode = None
                pid = os.getpid()   # 永远不会被真的杀掉;下面把发信号打桩掉

                async def wait(self):
                    await asyncio.sleep(3600)

            session.process = SlowProcess()
            signalled = []
            session._signal_process_group = lambda sig: signalled.append(sig)

            stopping = asyncio.create_task(session.stop())
            # stop() 还挂在 wait() 上,但事件必须已经落盘了 —— 否则这段窗口里
            # 新接上来的 SSE 订阅会因为 status 已是终态而回放完直接关流,
            # 永远收不到 run.cancelled,手机界面就卡在 running。
            for _ in range(50):
                if any(e.get("event") == "run.cancelled" for e in session.replay(0)):
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(session.status, "cancelled")
            self.assertTrue(any(e.get("event") == "run.cancelled" for e in session.replay(0)))
            self.assertEqual(signalled, [signal.SIGTERM])

            stopping.cancel()
            await asyncio.wait({stopping})

    async def test_stop_is_idempotent_and_never_rewrites_a_finished_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            session = self._session(tmp)
            session.status = "completed"
            await session.stop()
            self.assertEqual(session.status, "completed")
            self.assertFalse(any(e.get("event") == "run.cancelled" for e in session.replay(0)))

            other = HarnessSession(
                session_id="hs_twice", spec=HARNESSES["claude"], cwd=tmp,
                log_path=Path(tmp) / "hs_twice.ndjson",
            )
            other.status = "running"
            await other.stop()
            await other.stop()
            cancelled = [e for e in other.replay(0) if e.get("event") == "run.cancelled"]
            self.assertEqual(len(cancelled), 1)


class RelayJoinTests(unittest.IsolatedAsyncioTestCase):
    async def test_join_token_mints_device_key_and_keeps_shared_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            relay = Relay(
                "server-key-0123456789",
                device_keys_path=os.path.join(tmp, "device-keys.json"),
            )
            captured = {}

            def fake_json_response(payload, **kwargs):
                captured["payload"] = payload
                captured["status"] = kwargs.get("status", 200)
                return payload

            mint_req = types.SimpleNamespace(
                headers={"Authorization": "Bearer server-key-0123456789"},
                path="/relay/api/join-tokens",
                json=lambda: asyncio.sleep(0, result={"machine": "LeoFold8"}),
            )
            with unittest.mock.patch.object(
                    relay_module.web, "json_response", fake_json_response, create=True):
                await relay.create_join_token(mint_req)
            token = captured["payload"]["token"]
            self.assertTrue(token)

            join_req = types.SimpleNamespace(
                headers={},
                path="/relay/api/join",
                json=lambda: asyncio.sleep(0, result={"token": token}),
            )
            with unittest.mock.patch.object(
                    relay_module.web, "json_response", fake_json_response, create=True):
                await relay.join(join_req)
            access = captured["payload"]["accessKey"]
            self.assertGreaterEqual(len(access), 16)
            self.assertEqual(captured["payload"]["machine"], "LeoFold8")

            ok = types.SimpleNamespace(
                headers={"Authorization": f"Bearer {access}"},
                path="/relay/api/machines",
            )
            self.assertTrue(relay._authorized(ok))
            shared = types.SimpleNamespace(
                headers={"Authorization": "Bearer server-key-0123456789"},
                path="/relay/api/machines",
            )
            self.assertTrue(relay._authorized(shared))

            reused = types.SimpleNamespace(
                headers={},
                path="/relay/api/join",
                json=lambda: asyncio.sleep(0, result={"token": token}),
            )
            with unittest.mock.patch.object(
                    relay_module.web, "json_response", fake_json_response, create=True):
                await relay.join(reused)
            self.assertEqual(captured["status"], 409)


if __name__ == "__main__":
    unittest.main()
