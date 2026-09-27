"""Session list hygiene on the Mac service (harness.py HarnessManager)."""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path

from .harness import HarnessManager


def _write_log(path: Path, harness: str = "claude", cwd: str = "/tmp/proj") -> None:
    path.write_text(json.dumps({"seq": 1, "event": "session.created",
                                "harness": harness, "cwd": cwd}) + "\n", encoding="utf-8")


class HarnessManagerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.sessions = self.home / "harness-sessions"
        self.sessions.mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_rehydrate_drops_week_old_orphans(self):
        fresh, stale = self.sessions / "hs_fresh.ndjson", self.sessions / "hs_stale.ndjson"
        _write_log(fresh)
        _write_log(stale)
        old = time.time() - HarnessManager.ORPHAN_RETENTION_S - 60
        os.utime(stale, (old, old))
        manager = HarnessManager(home=self.home)
        self.assertIn("hs_fresh", manager.sessions)
        self.assertNotIn("hs_stale", manager.sessions)
        self.assertFalse(stale.exists())

    async def test_archive_removes_session_and_log(self):
        log = self.sessions / "hs_a.ndjson"
        _write_log(log)
        manager = HarnessManager(home=self.home)
        self.assertTrue(await manager.archive("hs_a"))
        self.assertNotIn("hs_a", manager.sessions)
        self.assertFalse(log.exists())
        self.assertFalse(await manager.archive("hs_a"))

    def test_list_reports_title_updated_at_and_stale_idle(self):
        log = self.sessions / "hs_idle.ndjson"
        _write_log(log, cwd="/tmp/myproj")
        manager = HarnessManager(home=self.home)
        session = manager.sessions["hs_idle"]
        session.status = "idle"
        row = manager.list()[0]
        self.assertEqual(row["status"], "idle")
        self.assertIn("myproj", row["title"])
        self.assertGreater(row["updated_at"], 0)
        old = time.time() - HarnessManager.IDLE_STALE_S - 60
        os.utime(log, (old, old))
        self.assertEqual(manager.list()[0]["status"], "available")


if __name__ == "__main__":
    unittest.main()
