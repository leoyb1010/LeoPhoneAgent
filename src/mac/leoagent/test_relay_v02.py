"""中继 0.2:设备身份、配对确认、机器名钉扎、钥匙轮换、离线排队。

走真实的 HTTP / WebSocket(aiohttp TestServer),不 mock handler。
"""

import asyncio
import json
import os
import tempfile
import time
import unittest

try:
    import aiohttp
    from aiohttp.test_utils import TestClient, TestServer
    HAS_AIOHTTP = True
except ModuleNotFoundError:  # pragma: no cover
    HAS_AIOHTTP = False

MASTER = "server-key-0123456789"


@unittest.skipUnless(HAS_AIOHTTP, "aiohttp not installed")
class RelayV02Tests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from .relay import Relay
        self.tmp = tempfile.TemporaryDirectory()
        self.relay = Relay(
            MASTER,
            device_keys_path=os.path.join(self.tmp.name, "device-keys.json"),
            treasury_sync_path=os.path.join(self.tmp.name, "treasury.json"),
            treasury_asset_dir=os.path.join(self.tmp.name, "assets"),
        )
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

    async def register(self, name, key, pin=False):
        ws = await self.client.ws_connect("/relay/agent")
        self.sockets.append(ws)
        await ws.send_json({"type": "register", "name": name, "key": key, "pin": pin, "info": {}})
        msg = await ws.receive(timeout=3)
        if msg.type == aiohttp.WSMsgType.TEXT:
            return ws, json.loads(msg.data)
        return ws, None

    async def pinned_mac(self, name="MacBook"):
        ws, ack = await self.register(name, MASTER, pin=True)
        self.assertEqual(ack["type"], "registered")
        self.assertIn("machine_key", ack)
        return ws, ack["machine_key"]

    async def test_iphone_pairing_waits_for_mac_and_device_key_is_client_only(self):
        _, machine_key = await self.pinned_mac()
        r = await self.client.post("/relay/api/join-tokens", json={}, headers=self.auth(machine_key))
        self.assertEqual(r.status, 200)
        token = (await r.json())["token"]

        r = await self.client.post("/relay/api/join", json={"token": token, "name": "Leo 的 iPhone"})
        self.assertEqual(r.status, 202)
        pending = await r.json()
        poll = f"/relay/api/join/{pending['pendingId']}?secret={pending['pollSecret']}"
        self.assertEqual((await (await self.client.get(poll)).json())["status"], "pending")

        r = await self.client.get("/relay/api/join-requests", headers=self.auth(machine_key))
        requests = (await r.json())["requests"]
        self.assertEqual([q["name"] for q in requests], ["Leo 的 iPhone"])
        r = await self.client.post(f"/relay/api/join-requests/{requests[0]['id']}",
                                   json={"decision": "allow"}, headers=self.auth(machine_key))
        self.assertEqual(r.status, 200)

        body = await (await self.client.get(poll)).json()
        self.assertEqual(body["status"], "approved")
        device_key = body["accessKey"]
        # 钥匙只交付一次
        self.assertEqual((await self.client.get(poll)).status, 404)

        self.assertEqual((await self.client.get("/relay/api/machines", headers=self.auth(device_key))).status, 200)
        # 设备钥匙不能签发短码、不能管设备、不能注册机器
        self.assertEqual((await self.client.post("/relay/api/join-tokens", json={},
                                                 headers=self.auth(device_key))).status, 401)
        self.assertEqual((await self.client.get("/relay/api/devices", headers=self.auth(device_key))).status, 401)
        _, ack = await self.register("Rogue", device_key)
        self.assertIsNone(ack)

    async def test_denied_pairing_never_gets_a_key(self):
        _, machine_key = await self.pinned_mac()
        token = (await (await self.client.post("/relay/api/join-tokens", json={},
                                               headers=self.auth(machine_key))).json())["token"]
        pending = await (await self.client.post("/relay/api/join", json={"token": token})).json()
        requests = (await (await self.client.get("/relay/api/join-requests",
                                                 headers=self.auth(machine_key))).json())["requests"]
        await self.client.post(f"/relay/api/join-requests/{requests[0]['id']}",
                               json={"decision": "deny"}, headers=self.auth(machine_key))
        body = await (await self.client.get(
            f"/relay/api/join/{pending['pendingId']}?secret={pending['pollSecret']}")).json()
        self.assertEqual(body, {"status": "denied"})

    async def test_legacy_code_is_immediate_for_android(self):
        r = await self.client.post("/relay/api/join-tokens", json={"machine": "LeoFold8"}, headers=self.auth(MASTER))
        token = (await r.json())["token"]
        r = await self.client.post("/relay/api/join", json={"token": token})
        self.assertEqual(r.status, 200)
        body = await r.json()
        self.assertGreaterEqual(len(body["accessKey"]), 16)
        self.assertEqual(body["machine"], "LeoFold8")
        # 旧版设备钥匙可以注册未钉扎的名字(Android 作为机器),但顶不掉钉扎过的
        _, ack = await self.register("fold8", body["accessKey"])
        self.assertEqual(ack["type"], "registered")
        self.assertNotIn("machine_key", ack)
        await self.pinned_mac("MacBook")
        _, ack = await self.register("MacBook", body["accessKey"])
        self.assertIsNone(ack)

    async def test_pinned_name_rejects_master_until_unpinned(self):
        ws, machine_key = await self.pinned_mac()
        await ws.close()
        _, ack = await self.register("MacBook", MASTER)
        self.assertIsNone(ack, "主钥匙不能顶替钉扎过的名字")
        ws2, ack = await self.register("MacBook", machine_key)
        self.assertEqual(ack["type"], "registered")
        await ws2.close()
        # 回滚:用机器钥匙解除钉扎后,主钥匙(leoagent)又能注册同名
        r = await self.client.post("/relay/api/machines/MacBook/unpin", headers=self.auth(machine_key))
        self.assertEqual(r.status, 200)
        _, ack = await self.register("MacBook", MASTER)
        self.assertEqual(ack["type"], "registered")

    async def test_exchange_then_revoke_stops_the_device(self):
        r = await self.client.post("/relay/api/device/exchange", json={"name": "iPhone 18"}, headers=self.auth(MASTER))
        body = await r.json()
        key, device_id = body["accessKey"], body["deviceId"]
        self.assertEqual((await self.client.get("/relay/api/machines", headers=self.auth(key))).status, 200)
        _, machine_key = await self.pinned_mac()
        devices = (await (await self.client.get("/relay/api/devices", headers=self.auth(machine_key))).json())["devices"]
        self.assertIn(device_id, [d["id"] for d in devices])
        r = await self.client.delete(f"/relay/api/devices/{device_id}", headers=self.auth(machine_key))
        self.assertEqual(r.status, 200)
        self.assertEqual((await self.client.get("/relay/api/machines", headers=self.auth(key))).status, 401)
        # 设备钥匙不能换设备钥匙
        self.assertEqual((await self.client.post("/relay/api/device/exchange", json={},
                                                 headers=self.auth(key))).status, 401)

    async def test_rotation_splits_keys_and_master_expires(self):
        exchanged = await (await self.client.post("/relay/api/device/exchange", json={},
                                                  headers=self.auth(MASTER))).json()
        r = await self.client.post("/relay/api/admin/rotate", json={"grace_days": 0}, headers=self.auth(MASTER))
        register_key = (await r.json())["registerKey"]
        await asyncio.sleep(0.01)
        # 宽限期到了:主钥匙作废,已换好的设备钥匙照常
        self.assertEqual((await self.client.get("/relay/api/machines", headers=self.auth(MASTER))).status, 401)
        self.assertEqual((await self.client.get("/relay/api/machines",
                                                headers=self.auth(exchanged["accessKey"]))).status, 200)
        # 注册钥匙只能注册机器,不能当客户端
        _, ack = await self.register("cortex", register_key, pin=True)
        self.assertEqual(ack["type"], "registered")
        self.assertIn("machine_key", ack)
        self.assertEqual((await self.client.get("/relay/api/machines", headers=self.auth(register_key))).status, 401)

    async def test_v01_device_keys_migrate_to_hashes(self):
        from .relay import Relay
        legacy = "legacy-device-key-0123456789abcdef"
        tmp = tempfile.TemporaryDirectory()
        try:
            path = os.path.join(tmp.name, "device-keys.json")
            with open(path, "w") as f:
                json.dump({"keys": {legacy: time.time() + 3600}}, f)
            relay = Relay(MASTER, device_keys_path=path,
                          treasury_sync_path=os.path.join(tmp.name, "t.json"),
                          treasury_asset_dir=os.path.join(tmp.name, "a"))
            caller = relay._caller_from_key(legacy)
            self.assertEqual(caller.kind, "legacy")
            self.assertFalse(os.path.exists(path))
            self.assertTrue(os.path.exists(path + ".migrated-0.2"))
            with open(relay.state_path) as f:
                self.assertNotIn(legacy, f.read(), "状态文件里只能有哈希")
        finally:
            tmp.cleanup()

    async def test_caller_is_forwarded_and_offline_requests_are_queued(self):
        exchanged = await (await self.client.post("/relay/api/device/exchange", json={"name": "iPhone"},
                                                  headers=self.auth(MASTER))).json()
        key = exchanged["accessKey"]
        headers = {**self.auth(key), "X-Leo-Queue": "1", "X-Leo-Request-Id": "req-1"}
        r = await self.client.post("/relay/api/m/MacBook/harness/sessions", json={"prompt": "hi"}, headers=headers)
        self.assertEqual(r.status, 202)
        self.assertEqual((await r.json())["request_id"], "req-1")
        # 不带排队头的请求照旧 502
        r = await self.client.get("/relay/api/m/MacBook/health", headers=self.auth(key))
        self.assertEqual(r.status, 502)
        status = await (await self.client.get("/relay/api/queue/req-1", headers=self.auth(key))).json()
        self.assertEqual(status["status"], "queued")

        ws, ack = await self.pinned_mac("MacBook")
        frame = json.loads((await ws.receive(timeout=3)).data)
        self.assertEqual(frame["type"], "http")
        self.assertEqual(frame["path"], "/harness/sessions")
        self.assertEqual(frame["request_id"], "req-1")
        self.assertEqual(frame["caller"]["kind"], "iphone")
        self.assertEqual(frame["caller"]["device_id"], exchanged["deviceId"])
        await ws.send_json({"type": "resp", "id": frame["id"], "status": 200, "body": {"session_id": "s1"}})
        for _ in range(50):
            status = await (await self.client.get("/relay/api/queue/req-1", headers=self.auth(key))).json()
            if status["status"] == "delivered":
                break
            await asyncio.sleep(0.02)
        self.assertEqual(status["status"], "delivered")
        self.assertEqual(status["response"], {"session_id": "s1"})

    async def test_join_is_rate_limited_per_source(self):
        for _ in range(5):
            r = await self.client.post("/relay/api/join", json={"token": "nope"})
            self.assertEqual(r.status, 409)
        r = await self.client.post("/relay/api/join", json={"token": "nope"})
        self.assertEqual(r.status, 429)


if __name__ == "__main__":
    unittest.main()
