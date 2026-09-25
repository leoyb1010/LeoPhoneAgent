"""中继 0.2:设备身份、配对确认、机器名钉扎、钥匙轮换、离线排队、事件流合并与推送路由。

走真实的 HTTP / WebSocket(aiohttp TestServer),不 mock handler。
"""

import asyncio
import json
import os
import tempfile
import time
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlsplit

try:
    import aiohttp
    from aiohttp import web
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

    async def test_queued_requests_read_queued_while_the_first_is_delivered(self):
        exchanged = await (await self.client.post("/relay/api/device/exchange", json={"name": "iPhone"},
                                                  headers=self.auth(MASTER))).json()
        key = exchanged["accessKey"]
        for rid in ("req-1", "req-2"):
            headers = {**self.auth(key), "X-Leo-Queue": "1", "X-Leo-Request-Id": rid}
            r = await self.client.post("/relay/api/m/MacBook/harness/sessions/s1/send", json={"text": rid},
                                       headers=headers)
            self.assertEqual(r.status, 202)
        ws, _ = await self.pinned_mac("MacBook")
        first = json.loads((await ws.receive(timeout=3)).data)
        self.assertEqual(first["request_id"], "req-1")
        # req-2 is out of the queue but not sent yet: still "queued", never an unknown 404
        r = await self.client.get("/relay/api/queue/req-2", headers=self.auth(key))
        self.assertEqual((r.status, (await r.json())["status"]), (200, "queued"))
        await ws.send_json({"type": "resp", "id": first["id"], "status": 200, "body": {}})
        second = json.loads((await ws.receive(timeout=3)).data)
        self.assertEqual(second["request_id"], "req-2")

    async def test_a_revoked_devices_queued_request_is_not_delivered(self):
        ws, machine_key = await self.pinned_mac("MacBook")
        exchanged = await (await self.client.post("/relay/api/device/exchange", json={"name": "iPhone"},
                                                  headers=self.auth(MASTER))).json()
        await ws.close()
        for _ in range(50):
            if "MacBook" not in self.relay.machines:
                break
            await asyncio.sleep(0.02)
        headers = {**self.auth(exchanged["accessKey"]), "X-Leo-Queue": "1", "X-Leo-Request-Id": "req-9"}
        r = await self.client.post("/relay/api/m/MacBook/harness/sessions", json={"prompt": "hi", "full_auto": True},
                                   headers=headers)
        self.assertEqual(r.status, 202)
        r = await self.client.delete(f"/relay/api/devices/{exchanged['deviceId']}", headers=self.auth(machine_key))
        self.assertEqual(r.status, 200)
        ws2, _ = await self.register("MacBook", machine_key)
        with self.assertRaises(asyncio.TimeoutError):
            await ws2.receive(timeout=0.5)   # nothing delivered on the revoked device's behalf
        self.assertEqual(self.relay.queue_results["req-9"]["status"], "failed")

    async def test_join_is_rate_limited_per_source(self):
        for _ in range(5):
            r = await self.client.post("/relay/api/join", json={"token": "nope"})
            self.assertEqual(r.status, 409)
        r = await self.client.post("/relay/api/join", json={"token": "nope"})
        self.assertEqual(r.status, 429)

    # -- 事件流:message.delta 合并 ------------------------------------------------

    async def phone_stream(self, mac, after=0):
        """手机经中继开一条会话事件流;返回 (SSE 响应, 假 Mac 收到的 stream_open 帧)。"""
        resp = await self.client.get(f"/relay/api/m/MacBook/harness/sessions/s1/events?after={after}",
                                     headers=self.auth(MASTER))
        self.assertEqual(resp.status, 200)
        while True:  # 跳过上一条流的 stream_cancel
            frame = json.loads((await mac.receive(timeout=3)).data)
            if frame["type"] == "stream_open":
                return resp, frame

    @staticmethod
    async def mac_sends(mac, stream_id, events, close=False):
        for event in events:
            await mac.send_json({"type": "stream_data", "id": stream_id, "data": json.dumps(event)})
        if close:
            await mac.send_json({"type": "stream_close", "id": stream_id})

    @staticmethod
    async def read_sse(resp, until=None):
        """读手机收到的 data 帧,直到流结束或 until(已收到的帧) 为真。"""
        got = []
        while until is None or not until(got):
            line = await asyncio.wait_for(resp.content.readline(), 3)
            if not line:
                break
            if line.startswith(b"data: "):
                got.append(json.loads(line[6:]))
        return got

    @staticmethod
    def delta(seq, text):
        return {"event": "message.delta", "delta": text, "seq": seq, "session_id": "s1"}

    async def test_rapid_deltas_become_fewer_events_with_identical_text(self):
        mac, _ = await self.pinned_mac()
        resp, opened = await self.phone_stream(mac)
        chunks = [f"第{n}段 " for n in range(1, 41)]
        await self.mac_sends(mac, opened["id"], [self.delta(n, c) for n, c in enumerate(chunks, 1)])
        # 不关流:全文照样到齐,说明 60 ms 窗口到点自己会发,不必等下一帧
        got = await self.read_sse(resp, until=lambda got: got and got[-1]["seq"] == 40)
        self.assertLess(len(got), 40)
        self.assertEqual("".join(e["delta"] for e in got), "".join(chunks))
        seqs = [e["seq"] for e in got]
        self.assertEqual(seqs, sorted(set(seqs)))
        self.assertTrue(all(e["event"] == "message.delta" and e["session_id"] == "s1" for e in got))

    async def test_other_frames_flush_pending_text_first_and_in_order(self):
        from . import relay as relay_module
        mac, _ = await self.pinned_mac()

        def status(latest):
            return {"event": "journal.status", "type": "durability", "session_id": "s1",
                    "state": "pending", "latest_seq": latest}

        # 窗口拉到 30 秒:只有别的帧和关流能让正文发出去,结果与机器快慢无关
        with mock.patch.object(relay_module, "DELTA_COALESCE_S", 30):
            resp, opened = await self.phone_stream(mac)
            await self.mac_sends(mac, opened["id"], [
                {"type": "resume", "status": "ok", "after": 0, "min_after": 0},
                status(0), self.delta(1, "a"), status(1), self.delta(2, "b"), status(2),
                {"event": "tool.started", "tool": "Bash", "seq": 3, "session_id": "s1"},
                self.delta(4, "c"), self.delta(5, "d"),
                {"event": "run.completed", "output": "ok", "seq": 6, "session_id": "s1"},
                self.delta(7, "e"), self.delta(8, "f"), status(8),
            ], close=True)
            got = await self.read_sse(resp)
        self.assertEqual([(e.get("event") or e["type"], e.get("delta", e.get("latest_seq")), e.get("seq"))
                          for e in got], [
            ("resume", None, None),
            ("journal.status", 0, None),   # 没攒正文时状态帧照常直发
            ("message.delta", "ab", 2),
            ("journal.status", 2, None),   # 攒正文期间只留最新一条,紧跟在正文后面
            ("tool.started", None, 3),
            ("message.delta", "cd", 5),
            ("run.completed", None, 6),
            ("message.delta", "ef", 8),    # 关流时攒着的也要发出去
            ("journal.status", 8, None),
        ])

    async def test_resume_from_a_coalesced_event_replays_exactly_what_live_got(self):
        from . import relay as relay_module
        mac, _ = await self.pinned_mac()
        # 假 Mac 的事件日志,按 ?after=N 回放(与 harness 的 subscribe 同语义)
        log = [self.delta(n, f"w{n} ") for n in range(1, 11)]
        log.append({"event": "tool.started", "tool": "Bash", "seq": 11, "session_id": "s1"})
        log += [self.delta(n, f"w{n} ") for n in range(12, 21)]
        with mock.patch.object(relay_module, "DELTA_COALESCE_S", 30):
            live, opened = await self.phone_stream(mac)
            await self.mac_sends(mac, opened["id"], log, close=True)
            live_events = await self.read_sse(live)
            cursor = live_events[0]["seq"]
            self.assertEqual(cursor, 10, "前 10 段合成一条,游标是最后一段的 seq")
            # 手机拿这条的 seq 续传:回放一口气到,合并后必须和实时流收到的一模一样
            replay, opened = await self.phone_stream(mac, after=cursor)
            after = int(parse_qs(urlsplit(opened["path"]).query)["after"][0])
            await self.mac_sends(mac, opened["id"], [e for e in log if e["seq"] > after], close=True)
            replayed = await self.read_sse(replay)
        self.assertEqual(replayed, [e for e in live_events if e["seq"] > cursor])
        self.assertEqual("".join(e.get("delta", "") for e in live_events[:1] + replayed),
                         "".join(e.get("delta", "") for e in log))

    async def test_burst_bigger_than_the_relay_queue_reaches_a_healthy_phone_whole(self):
        mac, _ = await self.pinned_mac()
        resp, opened = await self.phone_stream(mac)
        # 接管长会话时 Mac 一口气回放几千条:中继要是读 ws 时不让出事件循环,
        # 转发协程插不上手,读得好好的手机也会被当成慢消费者丢帧、关流
        chunks = [f"w{n} " for n in range(1, 5001)]
        await self.mac_sends(mac, opened["id"], [self.delta(n, c) for n, c in enumerate(chunks, 1)], close=True)
        got = await self.read_sse(resp)
        self.assertEqual("".join(e["delta"] for e in got), "".join(chunks))
        self.assertEqual(got[-1]["seq"], 5000)

    async def test_slow_phone_is_closed_before_any_frame_past_a_dropped_one(self):
        mac, _ = await self.pinned_mac()
        entered, gate = asyncio.Event(), asyncio.Event()
        real_write = web.StreamResponse.write

        async def stalled_write(response, data):  # 手机读不动:中继往手机写就卡住
            entered.set()
            await gate.wait()
            return await real_write(response, data)

        tools = [{"event": "tool.started", "tool": "Bash", "seq": n, "session_id": "s1"} for n in range(1, 1100)]
        with mock.patch.object(web.StreamResponse, "write", stalled_write):
            resp, opened = await self.phone_stream(mac)
            await self.mac_sends(mac, opened["id"], tools[:1])
            await asyncio.wait_for(entered.wait(), 3)
            await self.mac_sends(mac, opened["id"], tools[1:])  # 队列 1024 帧,挤爆
            # 事件帧排在它们后面:中继处理到它,上面的帧都已处理完
            await mac.send_json({"type": "event", "event": {"event": "marker"}})
            for _ in range(300):
                if self.relay.recent_events:
                    break
                await asyncio.sleep(0.01)
            gate.set()
            got = await self.read_sse(resp)
        seqs = [e["seq"] for e in got]
        self.assertEqual(seqs[:1], [1])
        # 越过空洞的帧一条都不能发:否则手机游标跳过被挤掉的那条,续传也补不回来
        self.assertEqual(seqs, list(range(1, len(seqs) + 1)))

    async def test_a_mac_that_reconnects_closes_the_old_connections_streams(self):
        mac, key = await self.pinned_mac()
        resp, opened = await self.phone_stream(mac)
        await self.mac_sends(mac, opened["id"], [self.delta(1, "a")])
        # Mac 换网:新连接先注册上,旧连接这时才断
        _, ack = await self.register("MacBook", key)
        self.assertEqual(ack["type"], "registered")
        got = await self.read_sse(resp)  # 流必须结束,不能一直挂着
        self.assertEqual([e["seq"] for e in got], [1])

    # -- 推送路由 ------------------------------------------------------------------

    async def test_run_failed_sends_no_alert_push(self):
        class FakePusher:
            enabled = True

            def __init__(self):
                self.alerts = []

            async def send_alert(self, **kwargs):
                self.alerts.append(kwargs)
                return 1

        pusher = self.relay.apns = FakePusher()
        mac, _ = await self.pinned_mac()
        for name in ("run.failed", "run.completed"):
            await mac.send_json({"type": "event", "event": {"event": name, "session_id": "s1", "error": "boom"}})
        for _ in range(300):
            if len(self.relay.recent_events) == 2:
                break
            await asyncio.sleep(0.01)
        await asyncio.gather(*list(self.relay._bg_tasks))
        # 完成照推(对照组:推送这条路是通的),失败不推
        self.assertEqual([a["collapse_id"] for a in pusher.alerts], ["run.completed-s1"])
        # 失败事件照样留在最近事件里,手机回前台能补齐
        events = (await (await self.client.get("/relay/api/events", headers=self.auth(MASTER))).json())["events"]
        self.assertIn("run.failed", [e["event"]["event"] for e in events])


if __name__ == "__main__":
    unittest.main()
