import os
import sys
import tempfile
import types
import unittest

try:
    import aiohttp  # noqa: F401
except ModuleNotFoundError:
    # The logger is stdlib-only. CI can exercise it without installing the
    # relay network stack; postponed annotations keep web types unevaluated.
    stub = types.ModuleType("aiohttp")
    stub.WSMsgType = object()
    stub.web = types.SimpleNamespace()
    sys.modules["aiohttp"] = stub

from .relay import Relay


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


if __name__ == "__main__":
    unittest.main()
