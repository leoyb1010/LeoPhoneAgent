import asyncio
import hashlib
import json
import os
import signal
import sys
import tempfile
import time
import types
import unittest
import unittest.mock
from pathlib import Path

try:
    import aiohttp  # noqa: F401
    from aiohttp.test_utils import TestClient, TestServer
    HAS_AIOHTTP = True
except ModuleNotFoundError:
    # The logger is stdlib-only. CI can exercise it without installing the
    # relay network stack; postponed annotations keep web types unevaluated.
    stub = types.ModuleType("aiohttp")
    stub.WSMsgType = object()
    stub.web = types.SimpleNamespace()
    sys.modules["aiohttp"] = stub
    HAS_AIOHTTP = False

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


class RelayTreasurySyncTests(unittest.IsolatedAsyncioTestCase):
    def _relay(self, tmp):
        return Relay(
            "server-key-0123456789",
            device_keys_path=os.path.join(tmp, "device-keys.json"),
            treasury_sync_path=os.path.join(tmp, "treasury-sync.json"),
            treasury_asset_dir=os.path.join(tmp, "treasury-assets"),
        )

    async def _call(self, method, body=None, query=None):
        captured = {}

        def fake_json_response(payload, **kwargs):
            captured["payload"] = payload
            captured["status"] = kwargs.get("status", 200)
            return payload

        request = types.SimpleNamespace(
            headers={"Authorization": "Bearer server-key-0123456789"},
            path="/relay/api/treasury",
            query=query or {},
            json=lambda: asyncio.sleep(0, result=body),
        )
        with unittest.mock.patch.object(
                relay_module.web, "json_response", fake_json_response, create=True):
            await method(request)
        return captured

    @staticmethod
    def _change(change_id, item_id, updated_at, operation="upsert", title="title"):
        digest = hashlib.sha256(f"{change_id}:{item_id}:{updated_at}".encode()).hexdigest()
        result = {
            "change_id": change_id,
            "item_id": item_id,
            "operation": operation,
            "updated_at": updated_at,
            "origin_device_id": "ios-phone",
            "payload_digest": digest,
            "local_sequence": 1,
        }
        if operation == "upsert":
            result["item"] = {
                "id": item_id, "kind": "text", "title": title,
                "source_label": "iPhone", "created_at": updated_at,
                "updated_at": updated_at, "processing_state": "ready",
            }
        return result

    async def test_metadata_edit_from_another_device_cannot_rehome_the_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            relay = self._relay(tmp)
            created = self._change("origin-change", "photo-item", 1000)
            created["item"].update({
                "kind": "image", "mime_type": "image/jpeg", "byte_count": 4096,
                "content_digest": "a" * 64,
                "body_available": False, "attachment_available": True,
            })
            relay._apply_treasury_change(created, "ios-phone")

            # A second device pins the item. It holds no bytes, so its view of
            # kind, mime, digest and availability is a placeholder, not truth.
            edited = self._change("pin-change", "photo-item", 2000)
            edited["item"].update({
                "kind": "document", "mime_type": "", "byte_count": 0,
                "content_digest": "", "pinned": True,
                "body_available": False, "attachment_available": False,
            })
            ok, _ = relay._apply_treasury_change(edited, "mac:studio")
            self.assertTrue(ok)

            stored = relay.treasury_items["photo-item"]["item"]
            self.assertEqual(stored["asset_origin_device_id"], "ios-phone")
            self.assertEqual(stored["kind"], "image")
            self.assertEqual(stored["mime_type"], "image/jpeg")
            self.assertEqual(stored["byte_count"], 4096)
            self.assertEqual(stored["content_digest"], "a" * 64)
            self.assertTrue(stored["attachment_available"])
            # The shared metadata the editor does own still lands.
            self.assertTrue(stored["pinned"])

            # The change stream keeps the invariant every client asserts:
            # a change's envelope origin equals its item's origin.
            replicated = [entry for entry in relay.treasury_changes
                          if entry["change_id"] == "pin-change"][0]
            self.assertEqual(replicated["origin_device_id"], "mac:studio")
            self.assertEqual(replicated["item"]["origin_device_id"], "mac:studio")

            # An asset request is routed to the device that has the bytes.
            captured = {}

            def fake_json_response(payload, **kwargs):
                captured["payload"] = payload
                captured["status"] = kwargs.get("status", 200)
                return payload

            create = types.SimpleNamespace(
                headers={"Authorization": "Bearer server-key-0123456789"},
                path="/relay/api/treasury/assets/requests",
                json=lambda: asyncio.sleep(0, result={
                    "item_id": "photo-item", "asset_kind": "attachment",
                    "requester_device_id": "mac:studio",
                }),
            )
            with unittest.mock.patch.object(
                    relay_module.web, "json_response", fake_json_response, create=True):
                await relay.post_treasury_asset_request(create)
            self.assertIn(captured["status"], (200, 201))
            self.assertEqual(
                captured["payload"]["request"]["origin_device_id"], "ios-phone")

            # The origin device itself may still correct those fields.
            corrected = self._change("replace-change", "photo-item", 3000)
            corrected["item"].update({
                "kind": "image", "mime_type": "image/png", "byte_count": 8192,
                "content_digest": "b" * 64, "attachment_available": True,
            })
            relay._apply_treasury_change(corrected, "ios-phone")
            stored = relay.treasury_items["photo-item"]["item"]
            self.assertEqual(stored["mime_type"], "image/png")
            self.assertEqual(stored["content_digest"], "b" * 64)

    async def test_changes_are_idempotent_ordered_and_survive_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            relay = self._relay(tmp)
            first = self._change("c1", "item-1", 1000, title="new")
            response = await self._call(
                relay.post_treasury_changes,
                {"device_id": "ios-phone", "changes": [first]},
            )
            self.assertEqual(response["status"], 200)
            self.assertEqual(len(relay.treasury_changes), 1)

            # A replay is acknowledged but does not allocate another server sequence.
            await self._call(
                relay.post_treasury_changes,
                {"device_id": "ios-phone", "changes": [first]},
            )
            self.assertEqual(len(relay.treasury_changes), 1)

            # Older delete cannot erase a newer item; equal-time delete wins.
            older_delete = self._change("c2", "item-1", 999, operation="delete")
            await self._call(relay.post_treasury_changes,
                             {"device_id": "ios-phone", "changes": [older_delete]})
            self.assertFalse(relay.treasury_items["item-1"]["item"].get("deleted_at"))
            equal_delete = self._change("c3", "item-1", 1000, operation="delete")
            await self._call(relay.post_treasury_changes,
                             {"device_id": "ios-phone", "changes": [equal_delete]})
            self.assertTrue(relay.treasury_items["item-1"]["item"].get("deleted_at"))

            listing = await self._call(
                relay.get_treasury_changes, query={"after": "0", "limit": "20"})
            delivered = listing["payload"]["changes"]
            self.assertEqual([entry["applied"] for entry in delivered], [False, False, True])

            restarted = self._relay(tmp)
            self.assertEqual(len(restarted.treasury_changes), 3)
            self.assertTrue(restarted.treasury_items["item-1"]["item"].get("deleted_at"))
            tombstone = restarted.treasury_items["item-1"]["item"]
            self.assertEqual(tombstone["kind"], "text")
            self.assertGreater(tombstone["created_at"], 0)
            self.assertGreater(tombstone["updated_at"], 0)

    async def test_upload_ack_never_skips_a_rejected_or_out_of_order_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            relay = self._relay(tmp)
            first = self._change("c1", "item-1", 1000)
            first["local_sequence"] = 7
            invalid = self._change("bad", "item-2", 1001)
            invalid["local_sequence"] = 8
            invalid["payload_digest"] = "not-a-digest"
            later = self._change("c3", "item-3", 1002)
            later["local_sequence"] = 9
            response = await self._call(
                relay.post_treasury_changes,
                {"device_id": "ios-phone", "changes": [first, invalid, later]},
            )
            self.assertEqual(response["payload"]["ack_local_cursor"], 7)
            self.assertEqual([entry["item_id"] for entry in relay.treasury_changes], ["item-1"])

            out_of_order = self._change("c4", "item-4", 1003)
            out_of_order["local_sequence"] = 6
            response = await self._call(
                relay.post_treasury_changes,
                {"device_id": "ios-phone", "changes": [first, out_of_order]},
            )
            self.assertEqual(response["payload"]["ack_local_cursor"], 7)
            self.assertEqual(len(relay.treasury_changes), 1)

    async def test_assets_are_requested_on_demand_integrity_checked_and_persisted(self):
        with tempfile.TemporaryDirectory() as tmp:
            relay = self._relay(tmp)
            change = self._change("asset-change", "asset-item", 1000)
            change["item"].update({
                "body_available": True,
                "attachment_available": False,
            })
            relay._apply_treasury_change(change, "ios-phone")
            relay._persist_treasury_sync()
            headers = {"Authorization": "Bearer server-key-0123456789"}
            captured = {}

            def fake_json_response(payload, **kwargs):
                captured["payload"] = payload
                captured["status"] = kwargs.get("status", 200)
                return payload

            create = types.SimpleNamespace(
                headers=headers, path="/relay/api/treasury/assets/requests",
                json=lambda: asyncio.sleep(0, result={
                    "item_id": "asset-item", "asset_kind": "body",
                    "requester_device_id": "mac:test",
                }),
            )
            with unittest.mock.patch.object(
                    relay_module.web, "json_response", fake_json_response, create=True):
                await relay.post_treasury_asset_request(create)
            self.assertEqual(captured["status"], 201)
            request_id = captured["payload"]["request"]["id"]

            listing = types.SimpleNamespace(
                headers=headers, path="/relay/api/treasury/assets/requests",
                query={"origin_device_id": "ios-phone"},
            )
            with unittest.mock.patch.object(
                    relay_module.web, "json_response", fake_json_response, create=True):
                await relay.get_treasury_asset_requests(listing)
            self.assertEqual([row["id"] for row in captured["payload"]["requests"]], [request_id])

            body = "按需同步正文，不进入元数据刷新。".encode()
            digest = hashlib.sha256(body).hexdigest()

            class FakeContent:
                async def iter_chunked(self, _size):
                    yield body[:7]
                    yield body[7:]

            upload = types.SimpleNamespace(
                headers={**headers, "X-Treasury-Device-ID": "ios-phone",
                         "X-Treasury-Digest": digest,
                         "X-Treasury-Byte-Count": str(len(body)),
                         "Content-Type": "text/plain; charset=utf-8"},
                path=f"/relay/api/treasury/assets/{request_id}",
                match_info={"request_id": request_id}, content=FakeContent(),
            )
            bad_upload = types.SimpleNamespace(
                headers={**upload.headers, "X-Treasury-Digest": "0" * 64},
                path=upload.path, match_info=upload.match_info, content=FakeContent(),
            )
            with unittest.mock.patch.object(
                    relay_module.web, "json_response", fake_json_response, create=True):
                await relay.put_treasury_asset(bad_upload)
            self.assertEqual(captured["status"], 422)
            self.assertEqual(relay.treasury_asset_requests[request_id]["status"], "pending")
            self.assertFalse(os.path.exists(relay._treasury_asset_path(request_id)))

            with unittest.mock.patch.object(
                    relay_module.web, "json_response", fake_json_response, create=True):
                await relay.put_treasury_asset(upload)
            self.assertEqual(captured["status"], 200)

            denied = types.SimpleNamespace(
                headers={**headers, "X-Treasury-Device-ID": "android-other"},
                path=f"/relay/api/treasury/assets/{request_id}",
                match_info={"request_id": request_id},
            )
            with unittest.mock.patch.object(
                    relay_module.web, "json_response", fake_json_response, create=True):
                await relay.get_treasury_asset(denied)
            self.assertEqual(captured["status"], 404)

            file_response = {}

            def fake_file_response(path, headers=None):
                file_response.update({"path": path, "headers": headers or {}})
                return file_response

            download = types.SimpleNamespace(
                headers={**headers, "X-Treasury-Device-ID": "mac:test"},
                path=f"/relay/api/treasury/assets/{request_id}",
                match_info={"request_id": request_id},
            )
            with unittest.mock.patch.object(
                    relay_module.web, "FileResponse", fake_file_response, create=True):
                await relay.get_treasury_asset(download)
            with open(file_response["path"], "rb") as stream:
                self.assertEqual(stream.read(), body)
            self.assertEqual(file_response["headers"]["X-Treasury-Digest"], digest)
            self.assertEqual(file_response["headers"]["Accept-Ranges"], "bytes")

            if HAS_AIOHTTP:
                # Exercise aiohttp's real FileResponse path when the optional
                # relay runtime is installed. Stdlib-only CI still validates
                # the advertised Range contract through the mocked response.
                client = TestClient(TestServer(relay.build_app()))
                await client.start_server()
                try:
                    ranged = await client.get(
                        f"/relay/api/treasury/assets/{request_id}",
                        headers={**headers, "X-Treasury-Device-ID": "mac:test", "Range": "bytes=7-"},
                    )
                    self.assertEqual(ranged.status, 206)
                    self.assertEqual(
                        ranged.headers.get("Content-Range"),
                        f"bytes 7-{len(body) - 1}/{len(body)}",
                    )
                    self.assertEqual(ranged.headers.get("Accept-Ranges"), "bytes")
                    self.assertEqual(await ranged.read(), body[7:])
                finally:
                    await client.close()

            restarted = self._relay(tmp)
            self.assertEqual(restarted.treasury_asset_requests[request_id]["status"], "ready")
            self.assertTrue(os.path.isfile(restarted._treasury_asset_path(request_id)))

            restarted.treasury_asset_requests[request_id]["expires_at"] = time.time() - 1
            restarted._persist_treasury_sync()
            self.assertTrue(restarted._clean_treasury_asset_requests())
            self.assertNotIn(request_id, restarted.treasury_asset_requests)
            self.assertFalse(os.path.exists(restarted._treasury_asset_path(request_id)))
            after_cleanup = self._relay(tmp)
            self.assertNotIn(request_id, after_cleanup.treasury_asset_requests)

    async def test_attachment_upload_rejects_unsupported_or_mismatched_mime(self):
        with tempfile.TemporaryDirectory() as tmp:
            relay = self._relay(tmp)
            content = b"%PDF-safe-fixture"
            digest = hashlib.sha256(content).hexdigest()
            change = self._change("attachment-change", "attachment-item", 1000)
            change["item"].update({
                "attachment_available": True, "body_available": False,
                "mime_type": "application/pdf", "byte_count": len(content),
                "content_digest": digest,
            })
            relay._apply_treasury_change(change, "ios-phone")
            headers = {"Authorization": "Bearer server-key-0123456789"}
            captured = {}

            def fake_json_response(payload, **kwargs):
                captured["payload"] = payload
                captured["status"] = kwargs.get("status", 200)
                return payload

            create = types.SimpleNamespace(
                headers=headers, path="/relay/api/treasury/assets/requests",
                json=lambda: asyncio.sleep(0, result={
                    "item_id": "attachment-item", "asset_kind": "attachment",
                    "requester_device_id": "mac:test",
                }),
            )
            with unittest.mock.patch.object(
                    relay_module.web, "json_response", fake_json_response, create=True):
                await relay.post_treasury_asset_request(create)
            request_id = captured["payload"]["request"]["id"]

            class FakeContent:
                async def iter_chunked(self, _size):
                    yield content

            base_headers = {
                **headers, "X-Treasury-Device-ID": "ios-phone",
                "X-Treasury-Digest": digest,
                "X-Treasury-Byte-Count": str(len(content)),
            }
            for mime, expected in [
                    ("application/x-executable", 415), ("text/plain", 409)]:
                upload = types.SimpleNamespace(
                    headers={**base_headers, "Content-Type": mime},
                    path=f"/relay/api/treasury/assets/{request_id}",
                    match_info={"request_id": request_id}, content=FakeContent(),
                )
                with unittest.mock.patch.object(
                        relay_module.web, "json_response", fake_json_response, create=True):
                    await relay.put_treasury_asset(upload)
                self.assertEqual(captured["status"], expected)
                self.assertEqual(relay.treasury_asset_requests[request_id]["status"], "pending")

    async def test_legacy_snapshot_is_not_truncated_to_500(self):
        with tempfile.TemporaryDirectory() as tmp:
            relay = self._relay(tmp)
            items = [{
                "id": f"legacy-{index}", "kind": "text", "title": f"Item {index}",
                "source": "iPhone", "created_at": 1000 + index,
                "updated_at": 1000 + index,
            } for index in range(650)]
            response = await self._call(
                relay.put_collections,
                {"device_id": "ios-legacy", "items": items},
            )
            self.assertEqual(response["status"], 200)
            listing = await self._call(relay.get_collections)
            self.assertEqual(len(listing["payload"]["items"]), 650)

    async def test_one_time_legacy_file_import_has_rebuildable_sequences(self):
        with tempfile.TemporaryDirectory() as tmp:
            legacy_root = os.path.join(tmp, "home")
            os.makedirs(os.path.join(legacy_root, ".leoagent"))
            with open(os.path.join(legacy_root, ".leoagent", "collections.json"), "w",
                      encoding="utf-8") as stream:
                json.dump({"items": [{
                    "id": "legacy-file-item", "kind": "text", "title": "旧镜像",
                    "source": "iPhone", "created_at": 1000, "updated_at": 1001,
                }]}, stream)
            with unittest.mock.patch.dict(os.environ, {"HOME": legacy_root}):
                relay = self._relay(tmp)
            entry = relay.treasury_items["legacy-file-item"]
            self.assertGreater(entry["server_sequence"], 0)
            self.assertEqual(len(relay.treasury_changes), 1)
            snapshot = await self._call(
                relay.get_treasury_items, query={"after_sequence": "0", "limit": "10"})
            self.assertEqual(snapshot["payload"]["items"][0]["id"], "legacy-file-item")


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
