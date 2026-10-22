"""[P0] 离线排队落盘与在线快照:中继重启不丢手机排的任务,mini 巡检能读到在线机器。"""

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
class RelayQueuePersistTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.clients = []
        self.relay, self.client = await self.start_relay()

    async def asyncTearDown(self):
        for client in self.clients:
            await client.close()
        self.tmp.cleanup()

    async def start_relay(self):
        from .relay import Relay
        relay = Relay(
            MASTER,
            device_keys_path=os.path.join(self.tmp.name, "device-keys.json"),
            treasury_sync_path=os.path.join(self.tmp.name, "treasury.json"),
            treasury_asset_dir=os.path.join(self.tmp.name, "assets"),
        )
        client = TestClient(TestServer(relay.build_app()))
        await client.start_server()
        self.clients.append(client)
        return relay, client

    @staticmethod
    def auth(key):
        return {"Authorization": f"Bearer {key}"}

    async def register(self, client, name, key, pin=False):
        ws = await client.ws_connect("/relay/agent")
        await ws.send_json({"type": "register", "name": name, "key": key, "pin": pin,
                            "info": {"version": "1.13.4", "server": "leophoneagent"}})
        ack = json.loads((await ws.receive(timeout=3)).data)
        return ws, ack

    async def queue_one(self, client, rid):
        exchanged = await (await client.post("/relay/api/device/exchange", json={"name": "iPhone"},
                                             headers=self.auth(MASTER))).json()
        headers = {**self.auth(exchanged["accessKey"]), "X-Leo-Queue": "1", "X-Leo-Request-Id": rid}
        r = await client.post("/relay/api/m/MacBook/harness/sessions", json={"prompt": rid}, headers=headers)
        self.assertEqual(r.status, 202)
        return exchanged["accessKey"]

    async def test_queue_survives_relay_restart_and_is_delivered(self):
        ws, ack = await self.register(self.client, "MacBook", MASTER, pin=True)
        machine_key = ack["machine_key"]
        await ws.close()
        for _ in range(50):
            if "MacBook" not in self.relay.machines:
                break
            await asyncio.sleep(0.02)
        await self.queue_one(self.client, "req-p1")
        with open(self.relay.queue_path, encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual([i["request_id"] for i in saved["offline_queue"]["MacBook"]], ["req-p1"])
        self.assertEqual(oct(os.stat(self.relay.queue_path).st_mode & 0o777), "0o600")

        # 中继重启:新实例从盘上恢复排队,Mac 上线后照常投递。
        relay2, client2 = await self.start_relay()
        self.assertEqual([i["request_id"] for i in relay2.offline_queue["MacBook"]], ["req-p1"])
        ws2, _ = await self.register(client2, "MacBook", machine_key)
        frame = json.loads((await ws2.receive(timeout=3)).data)
        self.assertEqual(frame["request_id"], "req-p1")
        await ws2.send_json({"type": "resp", "id": frame["id"], "status": 200, "body": {"ok": True}})
        for _ in range(50):
            if relay2.queue_results.get("req-p1", {}).get("status") == "delivered":
                break
            await asyncio.sleep(0.02)
        self.assertEqual(relay2.queue_results["req-p1"]["status"], "delivered")
        with open(relay2.queue_path, encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["offline_queue"], {})
        self.assertEqual(saved["inflight"], {})
        self.assertEqual(saved["queue_results"]["req-p1"]["status"], "delivered")
        await ws2.close()

    async def test_inflight_items_go_back_to_the_front_after_a_crash(self):
        now = time.time()
        item = lambda rid: {"request_id": rid, "method": "POST", "path": "/x", "body": None,
                            "caller": {}, "queued_at": now}
        with open(self.relay.queue_path, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "offline_queue": {"MacBook": [item("b"), item("a")]},
                       "inflight": {"MacBook": [item("a")]},
                       "queue_results": {"old": {"status": "delivered", "at": now - 3 * 86400}}}, f)
        relay2, _ = await self.start_relay()
        self.assertEqual([i["request_id"] for i in relay2.offline_queue["MacBook"]], ["a", "b"])
        self.assertNotIn("old", relay2.queue_results)

    async def test_corrupt_queue_file_is_kept_and_relay_still_starts(self):
        with open(self.relay.queue_path, "w", encoding="utf-8") as f:
            f.write('{"offline_queue": {"MacBook": [')
        relay2, _ = await self.start_relay()
        self.assertEqual(relay2.offline_queue, {})
        kept = [n for n in os.listdir(self.tmp.name) if n.startswith("relay-queue.json.corrupt-")]
        self.assertEqual(len(kept), 1)

    async def test_status_file_tracks_online_machines(self):
        ws, _ = await self.register(self.client, "Studio", MASTER, pin=True)
        with open(self.relay.status_path, encoding="utf-8") as f:
            status = json.load(f)
        self.assertEqual([(m["name"], m["app_version"]) for m in status["machines"]], [("Studio", "1.13.4")])
        await ws.close()
        for _ in range(50):
            with open(self.relay.status_path, encoding="utf-8") as f:
                status = json.load(f)
            if not status["machines"]:
                break
            await asyncio.sleep(0.02)
        self.assertEqual(status["machines"], [])

    async def test_unexpected_send_error_puts_items_back_instead_of_sticking(self):
        # 审查发现:send_json 抛 RuntimeError(ws 已关)时整批卡在「排队中」直到中继重启。
        ws, ack = await self.register(self.client, "MacBook", MASTER, pin=True)
        machine_key = ack["machine_key"]
        await ws.close()
        for _ in range(50):
            if "MacBook" not in self.relay.machines:
                break
            await asyncio.sleep(0.02)
        await self.queue_one(self.client, "req-x1")
        from .relay import Machine

        class DeadWS:
            async def send_json(self, _):
                raise RuntimeError("websocket closed")
        machine = Machine("MacBook", DeadWS(), {})
        self.relay.machines["MacBook"] = machine
        await self.relay._flush_queue(machine)
        self.assertEqual([i["request_id"] for i in self.relay.offline_queue["MacBook"]], ["req-x1"])
        self.assertEqual(self.relay.queue_inflight, {})
        del self.relay.machines["MacBook"]
        ws2, _ = await self.register(self.client, "MacBook", machine_key)
        frame = json.loads((await ws2.receive(timeout=3)).data)
        self.assertEqual(frame["request_id"], "req-x1")
        await ws2.close()

    async def test_bad_item_in_queue_file_does_not_block_startup(self):
        now = time.time()
        with open(self.relay.queue_path, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "offline_queue": {"MacBook": [
                {"request_id": "ok", "queued_at": now},
                {"request_id": ["unhashable"], "queued_at": now},
                {"request_id": "bad-time", "queued_at": "yesterday"},
            ]}, "inflight": {}, "queue_results": {"r": {"status": "delivered", "at": "x"}}}, f)
        relay2, _ = await self.start_relay()
        self.assertEqual([i["request_id"] for i in relay2.offline_queue["MacBook"]], ["ok"])

    async def test_persisted_results_drop_response_bodies(self):
        self.relay.queue_results["r1"] = {"status": "delivered", "at": time.time(), "response": {"big": "x" * 1000}}
        self.relay._persist_queue()
        with open(self.relay.queue_path, encoding="utf-8") as f:
            saved = json.load(f)
        self.assertNotIn("response", saved["queue_results"]["r1"])
        self.assertIn("response", self.relay.queue_results["r1"])   # 内存里的照旧给手机查

    async def test_approvals_survive_event_buffer_overflow(self):
        self.relay._record_event("MacBook", {"event": "approval.request", "approval_id": "a1"})
        for i in range(self.relay.MAX_EVENTS + 20):
            self.relay._record_event("Studio", {"event": "automation.run.completed", "run_id": str(i)})
        kinds = [e["event"]["event"] for e in self.relay.recent_events]
        self.assertEqual(len(kinds), self.relay.MAX_EVENTS)
        self.assertIn("approval.request", kinds)

    async def test_status_file_is_written_at_startup(self):
        with open(self.relay.status_path, encoding="utf-8") as f:
            status = json.load(f)
        self.assertEqual(status["machines"], [])
        self.assertGreater(status["updated_at"], time.time() - 60)


if __name__ == "__main__":
    unittest.main()
