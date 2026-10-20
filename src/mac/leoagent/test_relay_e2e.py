"""中继端到端加密(e2e)与 Live Activity token 注销。

中继看不懂 /e2e 的信封:只能原样转发 body、原样回 Mac 的 body 与状态码,流里的密文帧不能被合并或改写;
离线排队也得照样认 /e2e。走真实的 HTTP / WebSocket(aiohttp TestServer)。
"""

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path

try:
    import aiohttp
    from aiohttp.test_utils import TestClient, TestServer
    HAS_AIOHTTP = True
except ModuleNotFoundError:  # pragma: no cover
    HAS_AIOHTTP = False

MASTER = "server-key-0123456789"
ENVELOPE = {"v": 1, "k": "zo060cy2M-x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk", "c": "jB7nKhyYdOR2vLbrsAbGy_GqLMjx"}
TOKEN_A = "a" * 64
TOKEN_B = "b" * 64


@unittest.skipUnless(HAS_AIOHTTP, "aiohttp not installed")
class RelayE2ETests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from .apns import APNsPusher
        from .relay import Relay
        self.tmp = tempfile.TemporaryDirectory()
        self.relay = Relay(
            MASTER,
            device_keys_path=os.path.join(self.tmp.name, "device-keys.json"),
            treasury_sync_path=os.path.join(self.tmp.name, "treasury.json"),
            treasury_asset_dir=os.path.join(self.tmp.name, "assets"),
        )
        self.relay.apns = APNsPusher(home=Path(self.tmp.name))
        self.client = TestClient(TestServer(self.relay.build_app()))
        await self.client.start_server()
        self.sockets = []

    async def asyncTearDown(self):
        for ws in self.sockets:
            await ws.close()
        await self.client.close()
        self.tmp.cleanup()

    @staticmethod
    def auth(key):
        return {"Authorization": f"Bearer {key}"}

    async def device(self, name="iPhone"):
        r = await self.client.post("/relay/api/device/exchange", json={"name": name}, headers=self.auth(MASTER))
        return (await r.json())["accessKey"]

    async def mac(self):
        ws = await self.client.ws_connect("/relay/agent")
        self.sockets.append(ws)
        await ws.send_json({"type": "register", "name": "MacBook", "key": MASTER, "pin": True, "info": {}})
        await ws.receive(timeout=3)
        return ws

    async def test_envelope_and_reply_pass_through_untouched(self):
        key = await self.device()
        ws = await self.mac()
        sealed_reply = {"v": 1, "c": "ciphertext-of-the-reply"}

        async def mac_side():
            frame = json.loads((await ws.receive(timeout=3)).data)
            self.assertEqual(frame["type"], "http")
            self.assertEqual(frame["path"], "/e2e")
            self.assertEqual(frame["body"], ENVELOPE)
            await ws.send_json({"type": "resp", "id": frame["id"], "status": 403, "body": sealed_reply})

        task = asyncio.ensure_future(mac_side())
        r = await self.client.post("/relay/api/m/MacBook/e2e", json=ENVELOPE, headers=self.auth(key))
        await task
        # 外层状态码是 Mac 照抄的内层状态:中继原样回,不当成自己的鉴权失败。
        self.assertEqual(r.status, 403)
        self.assertEqual(await r.json(), sealed_reply)

    async def test_e2e_stream_frames_are_relayed_verbatim(self):
        key = await self.device()
        ws = await self.mac()
        frames = [json.dumps({"v": 1, "c": f"frame-{n}"}) for n in range(3)]

        async def mac_side():
            frame = json.loads((await ws.receive(timeout=3)).data)
            self.assertEqual(frame["type"], "stream_open")
            self.assertTrue(frame["path"].startswith("/e2e/events?v=1&k="))
            for data in frames:
                await ws.send_json({"type": "stream_data", "id": frame["id"], "data": data})
            await ws.send_json({"type": "stream_close", "id": frame["id"]})

        task = asyncio.ensure_future(mac_side())
        r = await self.client.get(f"/relay/api/m/MacBook/e2e/events?v=1&k={ENVELOPE['k']}&c={ENVELOPE['c']}",
                                  headers=self.auth(key))
        body = await r.text()
        await task
        self.assertEqual(r.status, 200)
        self.assertEqual([line[6:] for line in body.split("\n") if line.startswith("data: ")], frames)

    async def test_offline_e2e_send_is_queued_and_delivered_as_is(self):
        key = await self.device()
        headers = {**self.auth(key), "X-Leo-Queue": "1", "X-Leo-Request-Id": "req-e2e"}
        r = await self.client.post("/relay/api/m/MacBook/e2e", json=ENVELOPE, headers=headers)
        self.assertEqual(r.status, 202)
        ws = await self.mac()
        frame = json.loads((await ws.receive(timeout=3)).data)
        self.assertEqual((frame["path"], frame["body"], frame["request_id"]), ("/e2e", ENVELOPE, "req-e2e"))
        await ws.send_json({"type": "resp", "id": frame["id"], "status": 202, "body": {"v": 1, "c": "x"}})
        for _ in range(50):
            status = await (await self.client.get("/relay/api/queue/req-e2e", headers=self.auth(key))).json()
            if status["status"] == "delivered":
                break
            await asyncio.sleep(0.02)
        self.assertEqual((status["status"], status["http_status"]), ("delivered", 202))

    async def test_activity_token_unregister(self):
        alice, bob = await self.device("alice"), await self.device("bob")
        for key, token in ((alice, TOKEN_A), (bob, TOKEN_B)):
            r = await self.client.post("/relay/api/device", headers=self.auth(key), json={
                "kind": "activity_update", "token": token, "bundle_id": "com.example.app",
                "environment": "development", "session_ids": ["s1"]})
            self.assertEqual(r.status, 200)
        self.assertIn(TOKEN_A, self.relay.live_planner.cards)

        # 没钥匙不行;别的设备登记的 token 删不掉(回 404,不透露归属)。
        r = await self.client.delete("/relay/api/device/activity-token", json={"token": TOKEN_A})
        self.assertEqual(r.status, 401)
        r = await self.client.delete("/relay/api/device/activity-token", headers=self.auth(bob), json={"token": TOKEN_A})
        self.assertEqual(r.status, 404)
        r = await self.client.delete("/relay/api/device/activity-token", headers=self.auth(alice), json={"token": "x"})
        self.assertEqual(r.status, 400)

        r = await self.client.delete("/relay/api/device/activity-token", headers=self.auth(alice),
                                     json={"token": TOKEN_A.upper()})
        self.assertEqual(r.status, 200)
        self.assertEqual(await r.json(), {"ok": True, "removed": True})
        self.assertEqual(self.relay.apns.update_tokens_by_session(), {"s1": [TOKEN_B]})
        self.assertNotIn(TOKEN_A, self.relay.live_planner.cards)
        owner = next(d for d in self.relay.devices.values() if d.get("name") == "alice")
        self.assertEqual(owner["push_tokens"]["activity_update"], [])
        # 幂等:再删一次照样 ok。
        r = await self.client.delete("/relay/api/device/activity-token", headers=self.auth(alice), json={"token": TOKEN_A})
        self.assertEqual(await r.json(), {"ok": True, "removed": False})


if __name__ == "__main__":
    unittest.main()
