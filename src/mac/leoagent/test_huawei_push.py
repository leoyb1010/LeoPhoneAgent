"""Production Huawei push tests with an HTTP transport adapter, no network calls."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from .huawei_push import BUNDLE_ID, HuaweiPusher
from . import huawei_push


class HuaweiPushTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.pusher = HuaweiPusher(self.home)

    def register(self, owner="device-a", token="TOKEN_A" * 8):
        self.assertTrue(self.pusher.register(owner, token, BUNDLE_ID))
        return token

    def test_token_is_opaque_and_rotation_is_durable(self):
        token = self.register()
        self.assertIn(token, self.pusher._data["devices"])
        self.assertNotIn(token.lower(), self.pusher._data["devices"])
        self.assertEqual(os.stat(self.pusher.path).st_mode & 0o777, 0o600)
        self.assertFalse(self.pusher.register("other", token, BUNDLE_ID))
        new = "RefreshedToken" * 8
        self.register(token=new)
        fresh = HuaweiPusher(self.home)
        self.assertEqual(list(fresh._data["devices"]), [new])

    def test_invalid_destinations_rejected(self):
        for token in ["short", "\r\n" * 20, "a" * 4097, None]:
            self.assertFalse(self.pusher.register("device", token, BUNDLE_ID))
        self.assertFalse(self.pusher.register("device", "token" * 20, "other.bundle"))

    def test_revoke_owner_preserves_other_devices(self):
        one = self.register()
        two = self.register("device-b", "TOKEN_B" * 8)
        self.pusher.forget_owner("device-a")
        fresh = HuaweiPusher(self.home)
        self.assertNotIn(one, fresh._data["devices"])
        self.assertIn(two, fresh._data["devices"])

    def test_corruption_disables_without_overwriting(self):
        self.pusher.path.write_text('{broken')
        broken = HuaweiPusher(self.home)
        self.assertFalse(broken.enabled)
        self.assertTrue(broken.status()["registry_error"])
        with self.assertRaises(OSError):
            broken.register("device", "token" * 20, BUNDLE_ID)
        self.assertEqual(broken.path.read_text(), '{broken')

    def test_failed_replace_preserves_old_destination(self):
        old = self.register()
        with patch.object(huawei_push.os, "replace", side_effect=OSError("injected")):
            with self.assertRaises(OSError):
                self.register(token="new-token" * 10)
        self.assertIn(old, self.pusher._data["devices"])
        self.assertIn(old, HuaweiPusher(self.home)._data["devices"])


    def test_ps256_matches_official_claims(self):
        try:
            from cryptography.hazmat.primitives.asymmetric import rsa
            from cryptography.hazmat.primitives import serialization
            import jwt
        except ImportError:
            self.skipTest("existing APNs signing dependencies unavailable")
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption()).decode()
        account = self.home / "service-account.json"
        account.write_text(json.dumps({"key_id": "test-key", "sub_account": "test-account", "private_key": pem}))
        self.pusher.config = {"service_account_path": str(account), "project_id": "123"}
        token = self.pusher._authorization()
        claims = jwt.decode(token, key.public_key(), algorithms=["PS256"], audience=huawei_push.AUDIENCE)
        self.assertEqual(claims["iss"], "test-account")
        self.assertEqual(claims["exp"] - claims["iat"], 3600)
        self.assertEqual(jwt.get_unverified_header(token)["kid"], "test-key")

    async def test_send_is_redacted_deduplicated_and_revocation_gated(self):
        token = self.register()
        self.pusher.config = {"project_id": "12345", "test_message": True}
        self.pusher._authorization = lambda: "signed-auth"
        calls = []
        class Response:
            status_code = 200
            def json(self): return {"code": "80000000"}
        class Client:
            def __init__(self, **options):
                self.options = options
            async def __aenter__(self): return self
            async def __aexit__(self, *_): pass
            async def post(self, url, **kwargs):
                calls.append((url, kwargs, self.options))
                return Response()
        fake = type("Transport", (), {"AsyncClient": Client})
        event = {"event": "approval.request", "session_id": "session-a", "approval_id": "approval-a", "seq": 5,
                 "command": "PRIVATE_SECRET", "tool": "PRIVATE_SECRET"}
        with patch.object(huawei_push, "httpx", fake), patch.object(huawei_push, "jwt", object()):
            self.assertEqual(await self.pusher.send_event("mini", event, lambda owner: True), 1)
            self.assertEqual(await self.pusher.send_event("mini", event, lambda owner: True), 0)
            self.assertEqual(await self.pusher.send_event("mini", {**event, "seq": 6}, lambda owner: False), 0)
        self.assertEqual(len(calls), 1)
        url, request, options = calls[0]
        self.assertIn("/v3/12345/messages:send", url)
        self.assertFalse(options["follow_redirects"])
        self.assertEqual(request["headers"]["push-type"], "0")
        self.assertEqual(request["json"]["target"]["token"], [token])
        self.assertNotIn("PRIVATE_SECRET", json.dumps(request))
        click = request["json"]["payload"]["notification"]["clickAction"]
        self.assertEqual(click["data"], {"machine": "mini", "session_id": "session-a"})

    async def test_vendor_failure_does_not_poison_dedupe(self):
        self.register()
        self.pusher.config = {"project_id": "12345", "test_message": True}
        self.pusher._authorization = lambda: "signed-auth"
        class Response:
            status_code = 200
            def json(self): return {"code": "80300002"}
        class Client:
            def __init__(self, **_): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *_): pass
            async def post(self, *_args, **_kwargs): return Response()
        with patch.object(huawei_push, "httpx", type("Transport", (), {"AsyncClient": Client})), patch.object(huawei_push, "jwt", object()):
            result = await self.pusher.send_event("mini", {"event": "run.completed", "session_id": "session-a"}, lambda _: True)
        self.assertEqual(result, 0)
        self.assertEqual(self.pusher._data["sent"], {})


class HuaweiRelayIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        try:
            from aiohttp.test_utils import TestClient, TestServer
            from .relay import Relay
        except ImportError:
            self.skipTest("native relay aiohttp dependency unavailable")
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        home = Path(self.temp.name)
        self.relay = Relay("master-key-0123456789", device_keys_path=str(home / "identity.json"),
                           state_path=str(home / "relay.json"), treasury_sync_path=str(home / "treasury.json"),
                           treasury_asset_dir=str(home / "assets"))
        self.client = TestClient(TestServer(self.relay.build_app()))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)

    async def test_harmony_routes_separately_and_revoke_cleans_owner(self):
        key, identity = self.relay._create_device("Harmony", "iphone")
        with patch.object(self.relay.apns, "register", side_effect=AssertionError("Huawei token reached APNs")):
            response = await self.client.post("/relay/api/device", headers={"Authorization": "Bearer " + key},
                json={"platform": "harmony", "kind": "device", "token": "OpaqueHuaweiToken" * 4, "bundle_id": BUNDLE_ID})
            self.assertEqual(response.status, 200)
            self.assertTrue((await response.json())["ok"])
        self.assertEqual(next(iter(self.relay.huawei._data["devices"].values()))["owner"], identity)
        response = await self.client.delete("/relay/api/devices/" + identity,
            headers={"Authorization": "Bearer master-key-0123456789"})
        self.assertEqual(response.status, 200)
        self.assertEqual(self.relay.huawei._data["devices"], {})

    async def test_existing_ios_still_uses_apns(self):
        with patch.object(self.relay.apns, "register", return_value=True) as register:
            response = await self.client.post("/relay/api/device", headers={"Authorization": "Bearer master-key-0123456789"},
                json={"token": "a" * 64, "kind": "device", "bundle_id": "com.leoyuan.leophoneagent"})
            self.assertEqual(response.status, 200)
            self.assertTrue((await response.json())["ok"])
            self.assertEqual(register.call_args.kwargs["token"], "a" * 64)
        self.assertEqual(self.relay.huawei._data["devices"], {})


if __name__ == "__main__":
    unittest.main()
