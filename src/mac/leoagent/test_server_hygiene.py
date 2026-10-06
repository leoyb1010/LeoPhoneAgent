"""Resource hygiene of the Mac service: streams, idle CLIs, process groups, approvals."""
import asyncio
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from aiohttp.test_utils import TestClient, TestServer

from . import server as server_module
from .harness import HarnessManager, HarnessSession, HarnessSpec
from .server import LeoAgentServer

KEY = "test-key-0123456789abcdef"


def _write_log(path: Path) -> None:
    path.write_text(json.dumps({"seq": 1, "event": "session.created",
                                "harness": "claude", "cwd": "/tmp/p"}) + "\n", encoding="utf-8")


class _Home(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        (self.home / "harness-sessions").mkdir(parents=True)

    def tearDown(self):
        self.tmp.cleanup()

    def idle_session(self, manager: HarnessManager, session_id: str = "hs_a") -> HarnessSession:
        session = manager.sessions[session_id]
        session.status = "idle"
        return session


class ArchiveWakesStreams(_Home):
    async def test_archive_ends_a_parked_subscriber(self):
        _write_log(self.home / "harness-sessions" / "hs_a.ndjson")
        manager = HarnessManager(home=self.home)
        session = self.idle_session(manager)
        seen = []

        async def consume():
            async for event in session.subscribe():
                seen.append(event)

        task = asyncio.create_task(consume())
        await asyncio.sleep(0.05)
        self.assertEqual(len(session._subscribers), 1)
        self.assertTrue(await manager.archive("hs_a"))
        await asyncio.wait_for(task, timeout=1)   # used to hang forever
        self.assertEqual(session._subscribers, [])
        self.assertEqual([e["event"] for e in seen], ["session.created"])


class EventsKeepAlive(_Home):
    async def test_idle_stream_gets_keepalives_and_closes_on_archive(self):
        _write_log(self.home / "harness-sessions" / "hs_a.ndjson")
        server = LeoAgentServer(key=KEY, home=self.home)
        self.idle_session(server.manager)
        with mock.patch.object(server_module, "KEEPALIVE_S", 0.05):
            async with TestClient(TestServer(server.build_app())) as client:
                resp = await client.get("/harness/sessions/hs_a/events",
                                        headers={"Authorization": f"Bearer {KEY}"})
                self.assertEqual(resp.status, 200)
                body = b""
                while b": keep-alive" not in body:
                    body += await asyncio.wait_for(resp.content.readany(), timeout=1)
                self.assertIn(b'"session.created"', body)
                await server.manager.archive("hs_a")
                rest = await asyncio.wait_for(resp.content.read(), timeout=1)
                self.assertNotIn(b"data:", rest)


class IdleReaper(_Home):
    async def test_only_long_idle_sessions_are_stopped(self):
        for sid in ("hs_old", "hs_new"):
            _write_log(self.home / "harness-sessions" / f"{sid}.ndjson")
        manager = HarnessManager(home=self.home)
        old = self.idle_session(manager, "hs_old")
        new = self.idle_session(manager, "hs_new")
        past = time.time() - HarnessManager.IDLE_REAP_S - 60
        os.utime(old.log_path, (past, past))
        self.assertEqual(await manager.reap_idle(), ["hs_old"])
        self.assertEqual(old.status, "cancelled")
        self.assertEqual(new.status, "idle")


class ProcessGroupSweep(_Home):
    async def test_background_children_die_when_the_cli_exits_on_its_own(self):
        spec = HarnessSpec(key="sh", display_name="sh", executable="/bin/sh",
                           args=["-c", "sleep 30 & echo $!; exit 0"], dialect="none")
        session = HarnessSession(session_id="hs_pg", spec=spec, cwd=self.tmp.name,
                                 log_path=self.home / "harness-sessions" / "hs_pg.ndjson")
        await session.start()
        await asyncio.wait_for(asyncio.gather(*session._tasks), timeout=5)
        child = int(next(e["delta"] for e in session.replay() if e["event"] == "message.delta"))
        for _ in range(50):
            try:
                os.kill(child, 0)
            except ProcessLookupError:
                break
            await asyncio.sleep(0.05)
        else:
            os.kill(child, 9)
            self.fail("background child of an exited CLI was left running")


class ApprovalNeedsIdentifiedCaller(_Home):
    async def test_unidentified_caller_cannot_allow(self):
        _write_log(self.home / "harness-sessions" / "hs_a.ndjson")
        server = LeoAgentServer(key=KEY, home=self.home)
        session = self.idle_session(server.manager)
        session.pending_approvals["a1"] = {"choices": ["once", "deny"]}
        async with TestClient(TestServer(server.build_app())) as client:
            resp = await client.post(
                "/harness/sessions/hs_a/approval", json={"choice": "once", "approval_id": "a1"},
                headers={"Authorization": f"Bearer {KEY}", "X-Leo-Caller-Kind": "unknown"})
            self.assertEqual(resp.status, 403)
            self.assertEqual((await resp.json())["error"]["code"], "device_not_recognized")
        self.assertIn("a1", session.pending_approvals)


if __name__ == "__main__":
    unittest.main()
