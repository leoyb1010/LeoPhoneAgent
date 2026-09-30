"""Fault-injection regressions for relay identity and active stream authorization."""

import asyncio
import json
import os
import tempfile
import time
import unittest
from unittest import mock

from aiohttp import WSMsgType
from aiohttp.test_utils import TestClient, TestServer

from .relay import Relay
from .relay_identity import valid_registry

MASTER = "test-master-0123456789abcdef"


class RelayHardeningTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.args = dict(device_keys_path=os.path.join(self.tmp.name, "devices.json"),
                         treasury_sync_path=os.path.join(self.tmp.name, "treasury.json"),
                         treasury_asset_dir=os.path.join(self.tmp.name, "assets"))
        self.relay = Relay(MASTER, **self.args)
        self.client = TestClient(TestServer(self.relay.build_app()))
        await self.client.start_server()
        self.sockets = []

    async def asyncTearDown(self):
        for ws in self.sockets:
            await ws.close()
        await self.client.close()
        self.tmp.cleanup()

    @staticmethod
    def auth(key=MASTER):
        return {"Authorization": f"Bearer {key}"}

    async def register(self):
        ws = await self.client.ws_connect("/relay/agent")
        self.sockets.append(ws)
        await ws.send_json({"type": "register", "name": "Mac", "key": MASTER, "pin": True})
        return ws, await ws.receive(timeout=2)

    async def exchange(self):
        response = await self.client.post("/relay/api/device/exchange", json={}, headers=self.auth())
        return await response.json()

    async def stream(self, ws, key=MASTER):
        response = await self.client.get("/relay/api/m/Mac/harness/sessions/s/events", headers=self.auth(key))
        self.assertEqual(response.status, 200)
        while True:
            frame = await ws.receive_json(timeout=2)
            if frame["type"] == "stream_open":
                return response, frame["id"]

    async def send(self, ws, stream_id, data):
        await ws.send_json({"type": "stream_data", "id": stream_id, "data": json.dumps(data)})

    async def test_revoke_discards_pending_delta_status_even_when_persistence_fails(self):
        ws, _ = await self.register()
        phone = await self.exchange()
        response, stream_id = await self.stream(ws, phone["accessKey"])
        other, other_id = await self.stream(ws)
        await self.send(ws, stream_id, {"event": "run.started"})
        self.assertIn(b"run.started", await asyncio.wait_for(response.content.readline(), 2))
        await response.content.readline()  # SSE separator
        with mock.patch("leoagent.relay.DELTA_COALESCE_S", 10):
            await self.send(ws, stream_id, {"event": "message.delta", "delta": "private", "seq": 1})
            await self.send(ws, stream_id, {"event": "journal.status", "state": "private"})
            await asyncio.sleep(0.03)  # place both frames in the coalescer, not just its queue
            with mock.patch.object(self.relay, "_save_state", return_value=False):
                result = await self.client.delete("/relay/api/devices/" + phone["deviceId"], headers=self.auth())
            self.assertEqual(result.status, 503)
            await self.send(ws, stream_id, {"event": "result", "secret": "later"})
            self.assertEqual(await asyncio.wait_for(response.read(), 2), b"")
        # Only the revoked subscription closes; the same Mac and other client keep working.
        await self.send(ws, other_id, {"event": "result", "ok": True})
        await ws.send_json({"type": "stream_close", "id": other_id})
        self.assertIn(b'"ok": true', await asyncio.wait_for(other.read(), 2))
        self.assertIn("Mac", self.relay.machines)

    async def test_expired_master_discards_pending_stream_before_next_write(self):
        ws, _ = await self.register()
        response, stream_id = await self.stream(ws)
        with mock.patch("leoagent.relay.DELTA_COALESCE_S", 10):
            await self.send(ws, stream_id, {"event": "message.delta", "delta": "private", "seq": 1})
            await asyncio.sleep(0.03)
            self.relay.master_expires_at = time.time() - 1
            await ws.send_json({"type": "stream_close", "id": stream_id})
            self.assertEqual(await asyncio.wait_for(response.read(), 2), b"")

    async def test_corrupt_or_unreadable_registry_never_falls_back_to_new_install(self):
        _, registered = await self.register()
        self.assertEqual(registered.type, WSMsgType.TEXT)
        self.relay.master_expires_at = time.time() - 1
        self.assertTrue(self.relay._save_state())
        with open(self.relay.state_path, encoding="utf8") as handle:
            good = json.load(handle)
        cases = ["{broken", "[]", json.dumps({**good, "master_expires_at": "invalid"}),
                 json.dumps({**good, "master_expires_at": float("nan")}),
                 json.dumps({**good, "pins": {"Mac": "bad-hash"}}),
                 json.dumps({**good, "version": 99}), json.dumps({"version": 2})]
        for raw in cases:
            with self.subTest(raw=raw):
                with open(self.relay.state_path, "w", encoding="utf8") as handle:
                    handle.write(raw)
                with self.assertRaises(RuntimeError):
                    Relay(MASTER, **self.args)
                with open(self.relay.state_path, encoding="utf8") as handle:
                    self.assertEqual(handle.read(), raw)
        with mock.patch("builtins.open", side_effect=PermissionError("unreadable")):
            with self.assertRaises(RuntimeError):
                Relay(MASTER, **self.args)

    async def test_failed_rotate_returns_failure_then_successful_retry_survives_restart(self):
        with mock.patch.object(self.relay, "_save_state", return_value=False):
            response = await self.client.post("/relay/api/admin/rotate", json={"grace_days": 30}, headers=self.auth())
        self.assertEqual(response.status, 503)
        self.assertNotIn("registerKey", await response.json())
        response = await self.client.post("/relay/api/admin/rotate", json={"grace_days": 0}, headers=self.auth())
        self.assertEqual(response.status, 200)
        key = (await response.json())["registerKey"]
        restored = Relay(MASTER, **self.args)
        self.assertIsNone(restored._caller_from_key(MASTER))
        self.assertEqual(restored._caller_from_key(key).kind, "register")

    async def test_failed_pin_never_advertises_machine_or_key_and_retry_is_durable(self):
        with mock.patch.object(self.relay, "_save_state", return_value=False):
            _, result = await self.register()
        self.assertEqual(result.type, WSMsgType.CLOSE)
        self.assertNotIn("Mac", self.relay.machines)
        self.assertNotIn("Mac", self.relay.pins)
        _, result = await self.register()
        key = json.loads(result.data)["machine_key"]
        restored = Relay(MASTER, **self.args)
        self.assertEqual(restored._caller_from_key(key).machine, "Mac")
        self.assertIn("Mac", restored.pins)

    async def test_pin_has_no_fallible_permission_step_after_registry_commit(self):
        # The old implementation committed a pin, then chmod failed and it
        # withheld the sole plaintext key. A restart made registration impossible.
        with mock.patch("leoagent.relay.os.chmod", side_effect=PermissionError("post-commit chmod")):
            _, result = await self.register()
        self.assertEqual(result.type, WSMsgType.TEXT)
        key = json.loads(result.data)["machine_key"]
        restored = Relay(MASTER, **self.args)
        self.assertEqual(restored._caller_from_key(key).machine, "Mac")
        self.assertEqual(os.stat(self.relay.state_path).st_mode & 0o777, 0o600)

    async def test_precommit_permission_failure_keeps_registry_and_retry_usable(self):
        with open(self.relay.state_path, "rb") as handle:
            before = handle.read()
        with mock.patch("leoagent.relay.os.fchmod", side_effect=PermissionError("pre-commit permission")):
            _, result = await self.register()
        self.assertEqual(result.type, WSMsgType.CLOSE)
        self.assertEqual(result.data, 1013)
        with open(self.relay.state_path, "rb") as handle:
            self.assertEqual(handle.read(), before)
        self.assertNotIn("Mac", self.relay.pins)
        self.assertNotIn("Mac", Relay(MASTER, **self.args).pins)
        # A reused temporary file with broad mode must be restricted before
        # becoming authoritative, even though O_CREAT's mode is then ignored.
        os.chmod(self.relay.state_path + ".tmp", 0o644)
        _, result = await self.register()
        self.assertEqual(result.type, WSMsgType.TEXT)
        key = json.loads(result.data)["machine_key"]
        self.assertEqual(Relay(MASTER, **self.args)._caller_from_key(key).machine, "Mac")
        self.assertEqual(os.stat(self.relay.state_path).st_mode & 0o777, 0o600)

    async def test_legacy_migration_keeps_source_on_write_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "devices.json")
            with open(source, "w", encoding="utf8") as handle:
                json.dump({"keys": {"legacy-fixture-0123456789": time.time() + 60}}, handle)
            args = {**self.args, "device_keys_path": source}
            with mock.patch.object(Relay, "_save_state", return_value=False):
                with self.assertRaises(RuntimeError):
                    Relay(MASTER, **args)
            self.assertTrue(os.path.exists(source))
            self.assertFalse(os.path.exists(source + ".migrated-0.2"))
            restored = Relay(MASTER, **args)
            self.assertEqual(restored._caller_from_key("legacy-fixture-0123456789").kind, "legacy")
            self.assertFalse(os.path.exists(source))

    async def test_registered_machine_names_256_and_257_round_trip(self):
        for length in (256, 257):
            with self.subTest(length=length):
                name = "m" * length
                ws = await self.client.ws_connect("/relay/agent")
                self.sockets.append(ws)
                await ws.send_json({"type": "register", "name": name, "key": MASTER, "pin": True})
                result = await ws.receive_json(timeout=2)
                self.assertEqual(result["type"], "registered")
                with open(self.relay.state_path, encoding="utf8") as handle:
                    self.assertTrue(valid_registry(json.load(handle)))
                restored = Relay(MASTER, **self.args)
                self.assertEqual(restored._caller_from_key(result["machine_key"]).machine, name)

    async def test_existing_long_name_pin_upgrades_without_changing_authority(self):
        name = "old-machine-" + "x" * 1024
        machine_key = "existing-machine-fixture-0123456789"
        with open(self.relay.state_path, encoding="utf8") as handle:
            saved = json.load(handle)
        saved["pins"][name] = Relay._hash_key(machine_key)
        saved["master_expires_at"] = time.time() - 1
        saved["revoked_devices"] = ["old-revoked-phone"]
        with open(self.relay.state_path, "w", encoding="utf8") as handle:
            json.dump(saved, handle)
        restored = Relay(MASTER, **self.args)
        self.assertEqual(restored._caller_from_key(machine_key).machine, name)
        self.assertIsNone(restored._caller_from_key(MASTER))
        self.assertEqual(restored.revoked_devices, {"old-revoked-phone"})
        self.assertTrue(restored._save_state())
        self.assertEqual(Relay(MASTER, **self.args).pins, saved["pins"])

    async def test_non_string_registration_rejected_before_pinning(self):
        ws = await self.client.ws_connect("/relay/agent")
        self.sockets.append(ws)
        await ws.send_json({"type": "register", "name": {"invalid": True}, "key": MASTER, "pin": True})
        response = await ws.receive(timeout=2)
        self.assertEqual(response.type, WSMsgType.CLOSE)
        self.assertFalse(self.relay.pins)
        self.assertFalse(self.relay.machines)
        self.assertFalse(Relay(MASTER, **self.args).pins)

    async def test_writer_rejects_invalid_candidate_without_replacing_valid_registry(self):
        with open(self.relay.state_path, encoding="utf8") as handle:
            original = handle.read()
        self.relay.master_expires_at = float("nan")
        self.assertFalse(self.relay._save_state())
        with open(self.relay.state_path, encoding="utf8") as handle:
            self.assertEqual(handle.read(), original)
        self.assertFalse(os.path.exists(self.relay.state_path + ".tmp"))
        self.assertIsNotNone(Relay(MASTER, **self.args)._caller_from_key(MASTER))

    async def test_nonfinite_legacy_expiry_preserves_source_and_fails_every_start(self):
        for expiry in (float("nan"), float("inf"), -float("inf")):
            with self.subTest(expiry=expiry), tempfile.TemporaryDirectory() as directory:
                source = os.path.join(directory, "devices.json")
                raw = json.dumps({"keys": {"legacy-fixture-0123456789": expiry}})
                with open(source, "w", encoding="utf8") as handle:
                    handle.write(raw)
                args = {**self.args, "device_keys_path": source}
                for _ in range(2):
                    with self.assertRaisesRegex(RuntimeError, "legacy device expiry"):
                        Relay(MASTER, **args)
                    with open(source, encoding="utf8") as handle:
                        self.assertEqual(handle.read(), raw)
                    self.assertFalse(os.path.exists(source + ".migrated-0.2"))
                    self.assertFalse(os.path.exists(os.path.join(directory, "relay-state.json")))
