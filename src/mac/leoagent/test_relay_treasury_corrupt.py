"""藏宝阁同步文件损坏时，中继不得把它当空库覆盖（Codex 评估 F02）。"""
import json
import os
import tempfile
import unittest

from leoagent.relay import Relay  # noqa: E402


class TreasuryCorruptStoreTest(unittest.TestCase):
    def test_corrupt_store_is_preserved_and_writes_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "treasury-sync.json")
            with open(path, "w", encoding="utf-8") as stream:
                stream.write('{"version":1,"changes":[{"change_id":"a"')
            relay = Relay.__new__(Relay)
            relay.treasury_sync_path = path
            relay.treasury_items = {}
            relay.treasury_changes = []
            relay.treasury_change_ids = set()
            relay.treasury_seen_change_order = []
            relay.treasury_next_sequence = 1
            relay.treasury_updated_at = 0.0
            relay.treasury_asset_requests = {}
            relay.treasury_sync_corrupt = None
            relay.treasury_sync_corrupt_backup = None
            relay._load_treasury_sync()
            self.assertIsNotNone(relay.treasury_sync_corrupt)
            self.assertTrue(relay.treasury_sync_corrupt_backup and os.path.exists(relay.treasury_sync_corrupt_backup))
            with self.assertRaises(OSError):
                relay._persist_treasury_sync()
            with open(path, encoding="utf-8") as stream:
                self.assertEqual(stream.read(), '{"version":1,"changes":[{"change_id":"a"')
            self.assertIsNotNone(relay._treasury_corrupt_response())

    def test_missing_store_is_fine(self):
        with tempfile.TemporaryDirectory() as tmp:
            relay = Relay.__new__(Relay)
            relay.treasury_sync_path = os.path.join(tmp, "treasury-sync.json")
            relay.treasury_items = {}
            relay.treasury_changes = []
            relay.treasury_change_ids = set()
            relay.treasury_seen_change_order = []
            relay.treasury_next_sequence = 1
            relay.treasury_updated_at = 0.0
            relay.treasury_asset_requests = {}
            relay.treasury_sync_corrupt = None
            relay.treasury_sync_corrupt_backup = None
            relay._load_treasury_sync()
            self.assertIsNone(relay.treasury_sync_corrupt)
            self.assertIsNone(relay._treasury_corrupt_response())


if __name__ == "__main__":
    unittest.main()
