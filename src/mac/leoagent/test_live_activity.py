"""WP-41 Live Activity 远程推送:规划逻辑、APNs 头与载荷、token 生命周期、中继接线。

APNs 全部 mock:不联网、不需要 .p8。
"""

import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from .apns import APNsPusher
from .live_activity import (APPLE_REFERENCE_EPOCH, APPROVAL_ICON, LiveActivityPlanner,
                            LiveActivityPush, aps_payload, content_state, snapshot)

try:
    import aiohttp
    from aiohttp.test_utils import TestClient, TestServer
    HAS_AIOHTTP = True
except ModuleNotFoundError:  # pragma: no cover
    HAS_AIOHTTP = False

TOKEN_A = "a" * 64
TOKEN_B = "b" * 64
START_TOKEN = "c" * 64
NOW = 1_800_000_000.0

# iOS AgentActivityAttributes.ContentState 的全部键(Swift 合成解码要求非可选键齐全)。
CONTENT_STATE_KEYS = {
    "activeSessionCount", "sessions", "carouselIndex", "soulName", "latestToolIcon",
    "minimalShowsTool", "allCompleted", "isAudioPlaying", "isAudioLoaded", "audioTitle", "privacyMode",
}
SNAPSHOT_KEYS = {"sessionId", "title", "toolIcon", "toolStatus", "loopIteration", "isCompleted",
                 "lastMessage", "outcome"}


class PlannerTests(unittest.TestCase):
    def test_approval_without_card_push_starts_one(self):
        planner = LiveActivityPlanner()
        pushes = planner.plan("approval.request", "MacBook", {"session_id": "s1", "tool": "Bash"}, {}, now=NOW)
        self.assertEqual(len(pushes), 1)
        push = pushes[0]
        self.assertEqual(push.event, "start")
        self.assertIsNone(push.token)
        self.assertEqual(push.content_state["sessions"][0]["toolIcon"], APPROVAL_ICON)
        self.assertIn("Bash", push.content_state["sessions"][0]["toolStatus"])
        self.assertEqual(push.alert["title"], "需要你批准")
        self.assertAlmostEqual(push.attributes["startDate"], NOW - APPLE_REFERENCE_EPOCH)
        # 同一会话十分钟内不再拉第二张卡;一般进度事件也不会
        self.assertEqual(planner.plan("approval.request", "MacBook", {"session_id": "s1"}, {}, now=NOW + 60), [])
        self.assertEqual(len(planner.plan("approval.request", "MacBook", {"session_id": "s1"}, {}, now=NOW + 601)), 1)

    def test_end_events_never_push_start(self):
        planner = LiveActivityPlanner()
        for kind in ("run.completed", "run.failed", "run.cancelled"):
            self.assertEqual(planner.plan(kind, "Mac", {"session_id": "s1"}, {}, now=NOW), [])
        self.assertEqual(planner.plan("run.progress", "Mac", {"session_id": "s1"}, {}, now=NOW), [])
        self.assertEqual(planner.plan("approval.request", "Mac", {}, {}, now=NOW), [])

    def test_update_token_gets_update_then_end(self):
        planner = LiveActivityPlanner()
        planner.bind(TOKEN_A, [{"session_id": "s1", "title": "🖥 Mac · Claude"}])
        tokens = {"s1": [TOKEN_A]}
        approval = planner.plan("approval.request", "Mac", {"session_id": "s1", "tool": "Bash"}, tokens, now=NOW)
        self.assertEqual([(p.event, p.token, p.priority) for p in approval], [("update", TOKEN_A, 10)])
        self.assertEqual(approval[0].content_state["sessions"][0]["title"], "🖥 Mac · Claude")  # 保留手机给的标题
        running = planner.plan("turn.started", "Mac", {"session_id": "s1"}, tokens, now=NOW + 1)
        self.assertEqual([(p.event, p.priority, p.alert) for p in running], [("update", 5, None)])
        done = planner.plan("run.completed", "Mac", {"session_id": "s1"}, tokens, now=NOW + 2)
        self.assertEqual([p.event for p in done], ["end"])
        self.assertEqual(done[0].dismissal_date, int(NOW + 2 + 5))
        self.assertTrue(done[0].content_state["allCompleted"])
        self.assertEqual(done[0].content_state["sessions"][0]["outcome"], "done")

    def test_one_of_two_sessions_finishing_updates_instead_of_ending(self):
        planner = LiveActivityPlanner()
        planner.bind(TOKEN_A, [{"session_id": "s1"}, {"session_id": "s2"}])
        tokens = {"s1": [TOKEN_A], "s2": [TOKEN_A]}
        pushes = planner.plan("run.failed", "Mac", {"session_id": "s1"}, tokens, now=NOW)
        self.assertEqual([p.event for p in pushes], ["update"])
        state = pushes[0].content_state
        self.assertEqual(state["activeSessionCount"], 1)
        rows = {row["sessionId"]: row for row in state["sessions"]}
        self.assertEqual(rows["s1"]["outcome"], "attention")
        self.assertFalse(rows["s2"]["isCompleted"])

    def test_automation_run_end_closes_unattended_approval_card(self):
        # 无人值守的定时任务:审批推送拉起「等你审批」卡,Mac 不推 run.*,只推 automation.run.completed。
        planner = LiveActivityPlanner()
        started = planner.plan("approval.request", "Mac", {"session_id": "task-1", "tool": "Bash"}, {}, now=NOW)
        self.assertEqual([p.event for p in started], ["start"])
        # 卡拉起后 iOS 登记 update token。
        planner.bind(TOKEN_A, [{"session_id": "task-1", "title": "🖥 Mac"}])
        tokens = {"task-1": [TOKEN_A]}
        # 审批答完回到运行中(只改已有的卡)。
        resumed = planner.plan("approval.responded", "Mac", {"session_id": "task-1"}, tokens, now=NOW + 1)
        self.assertEqual([(p.event, p.alert) for p in resumed], [("update", None)])
        self.assertEqual(resumed[0].content_state["sessions"][0]["toolStatus"], "运行中…")
        for status, outcome in (("succeeded", "done"), ("failed", "attention"), ("stopped", "stopped")):
            fresh = LiveActivityPlanner()
            fresh.bind(TOKEN_A, [{"session_id": "task-1"}])
            done = fresh.plan("automation.run.completed", "Mac",
                              {"session_id": "task-1", "status": status, "run_id": "r1"}, tokens, now=NOW + 2)
            self.assertEqual([(p.event, p.alert) for p in done], [("end", None)])  # 不额外响铃
            self.assertEqual(done[0].content_state["sessions"][0]["outcome"], outcome)
        failed = planner.plan("automation.run.failed", "Mac", {"session_id": "task-1"}, tokens, now=NOW + 3)
        self.assertEqual([p.event for p in failed], ["end"])
        self.assertEqual(failed[0].content_state["sessions"][0]["outcome"], "attention")

    def test_automation_end_and_resume_never_push_start(self):
        planner = LiveActivityPlanner()
        for kind in ("automation.run.completed", "automation.run.failed", "approval.responded", "approval.resolved"):
            self.assertEqual(planner.plan(kind, "Mac", {"session_id": "s1", "status": "succeeded"}, {}, now=NOW), [])
        # 卡上没有这个会话:结束/回执都不碰它。
        planner.bind(TOKEN_A, [{"session_id": "s2"}])
        self.assertEqual(planner.plan("automation.run.completed", "Mac", {"session_id": "s1", "status": "succeeded"},
                                      {"s1": [TOKEN_A]}, now=NOW), [])

    def test_payload_matches_ios_content_state(self):
        state = content_state([snapshot("s" * 100, "x" * 80, icon="terminal.fill", status="y" * 80)])
        self.assertEqual(set(state), CONTENT_STATE_KEYS)
        row = state["sessions"][0]
        self.assertEqual(set(row), SNAPSHOT_KEYS)
        self.assertLessEqual(len(row["title"]), 24)
        self.assertLessEqual(len(row["toolStatus"]), 32)
        self.assertLessEqual(len(row["sessionId"]), 64)
        start = aps_payload(LiveActivityPush("start", state, "s", alert={"title": "t", "body": "b"},
                                             attributes={"startDate": 1.0}, stale_date=5), now=NOW)["aps"]
        self.assertEqual(start["event"], "start")
        self.assertEqual(start["timestamp"], int(NOW))
        self.assertEqual(start["attributes-type"], "AgentActivityAttributes")
        self.assertEqual(start["attributes"], {"startDate": 1.0})
        self.assertEqual(start["alert"], {"title": "t", "body": "b"})
        self.assertEqual(start["stale-date"], 5)
        end = aps_payload(LiveActivityPush("end", state, "s", dismissal_date=9), now=NOW)["aps"]
        self.assertNotIn("attributes-type", end)
        self.assertEqual(end["dismissal-date"], 9)
        self.assertLess(len(json.dumps(start).encode()), 4096)


@unittest.skipUnless(HAS_AIOHTTP, "aiohttp not installed")
class DevicePushTokenTests(unittest.TestCase):
    def test_revoke_sees_every_kind_and_legacy_single_entry(self):
        from .relay import _device_push_tokens
        device = {"push_tokens": {"device": [TOKEN_B], "activity_update": [TOKEN_A, START_TOKEN]},
                  "push": {"kind": "activity_update", "token": START_TOKEN}}
        self.assertEqual(sorted(_device_push_tokens(device)),
                         sorted([("device", TOKEN_B), ("activity_update", TOKEN_A), ("activity_update", START_TOKEN)]))
        self.assertEqual(_device_push_tokens({"push": {"token": TOKEN_B}}), [("device", TOKEN_B)])
        self.assertEqual(_device_push_tokens({}), [])


class FakeResponse:
    def __init__(self, status, text=""):
        self.status_code, self.text = status, text


class FakeClient:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, headers=None, content=None):
        self.calls.append((url, dict(headers), json.loads(content)))
        status = self.responses.pop(0) if self.responses else (200, "")
        return FakeResponse(*status)


class TestPusher(APNsPusher):
    def __init__(self, home, responses=None):
        super().__init__(home=home)
        self.fake = FakeClient(list(responses or []))
        self.config = {"key_path": "k.p8", "key_id": "K", "team_id": "T", "topic": "com.example.app"}

    @property
    def enabled(self):
        return True

    def _auth_token(self):
        return "jwt"

    def _client(self):
        return self.fake


class PusherTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.env = mock.patch.dict(os.environ, {}, clear=False)
        self.env.start()
        os.environ.pop("LEOAGENT_LIVE_ACTIVITY_PUSH", None)

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()

    def test_activity_update_registration_needs_sessions(self):
        pusher = TestPusher(self.home)
        self.assertFalse(pusher.register("activity_update", TOKEN_A, "com.example.app", "development"))
        self.assertTrue(pusher.register("activity_update", TOKEN_A, "com.example.app", "development",
                                        session_ids=["s1", "s1", "s2"]))
        self.assertTrue(pusher.register("activity_update", TOKEN_B, "com.example.app", "production",
                                        session_ids=["s2"]))
        self.assertEqual(pusher.update_tokens_by_session(), {"s1": [TOKEN_A], "s2": [TOKEN_A, TOKEN_B]})
        self.assertFalse(pusher.register("bogus", TOKEN_A, "x", "development"))
        self.assertEqual(pusher.status()["devices"]["activity_update"], 2)

    async def test_start_goes_to_push_to_start_tokens_with_liveactivity_headers(self):
        pusher = TestPusher(self.home)
        pusher.register("push_to_start", START_TOKEN, "com.example.app", "production")
        pusher.register("device", TOKEN_B, "com.example.app", "production")
        state = content_state([snapshot("s1", "Mac", icon=APPROVAL_ICON, status="等你审批")])
        sent = await pusher.send_live_activity(LiveActivityPush("start", state, "s1", attributes={"startDate": 1.0}),
                                               now=NOW)
        self.assertEqual(sent, 1)
        url, headers, payload = pusher.fake.calls[0]
        self.assertEqual(url, f"https://api.push.apple.com/3/device/{START_TOKEN}")
        self.assertEqual(headers["apns-push-type"], "liveactivity")
        self.assertEqual(headers["apns-topic"], "com.example.app.push-type.liveactivity")
        self.assertEqual(headers["apns-priority"], "10")
        self.assertEqual(payload["aps"]["event"], "start")
        self.assertEqual(len(pusher.fake.calls), 1)  # 普通 device token 不收 Live Activity

    async def test_update_targets_one_token_and_end_forgets_it(self):
        pusher = TestPusher(self.home)
        pusher.register("activity_update", TOKEN_A, "com.example.app", "development", session_ids=["s1"])
        pusher.register("activity_update", TOKEN_B, "com.example.app", "development", session_ids=["s2"])
        state = content_state([snapshot("s1", "Mac", icon="terminal.fill", status="运行中")])
        await pusher.send_live_activity(LiveActivityPush("update", state, "s1", token=TOKEN_A, priority=5))
        url, headers, _ = pusher.fake.calls[-1]
        self.assertTrue(url.startswith("https://api.sandbox.push.apple.com/3/device/" + TOKEN_A))
        self.assertEqual(headers["apns-priority"], "5")
        await pusher.send_live_activity(LiveActivityPush("end", state, "s1", token=TOKEN_A))
        self.assertEqual(pusher.update_tokens_by_session(), {"s2": [TOKEN_B]})
        # 已摘除的 token 不再发
        calls = len(pusher.fake.calls)
        self.assertEqual(await pusher.send_live_activity(LiveActivityPush("update", state, "s1", token=TOKEN_A)), 0)
        self.assertEqual(len(pusher.fake.calls), calls)

    async def test_bad_token_dropped_and_rate_limit_not_retried(self):
        pusher = TestPusher(self.home, responses=[(410, '{"reason":"Unregistered"}'), (429, '{"reason":"TooManyRequests"}')])
        pusher.register("activity_update", TOKEN_A, "com.example.app", "development", session_ids=["s1"])
        pusher.register("activity_update", TOKEN_B, "com.example.app", "development", session_ids=["s2"])
        state = content_state([])
        self.assertEqual(await pusher.send_live_activity(LiveActivityPush("update", state, "s1", token=TOKEN_A)), 0)
        self.assertNotIn("s1", pusher.update_tokens_by_session())
        self.assertEqual(await pusher.send_live_activity(LiveActivityPush("update", state, "s2", token=TOKEN_B)), 0)
        self.assertEqual(len(pusher.fake.calls), 2)  # 429 只发一次
        self.assertIn("s2", pusher.update_tokens_by_session())

    async def test_kill_switch_falls_back_to_local_mode(self):
        (self.home / "apns.json").write_text(json.dumps({"live_activity_push": False}))
        pusher = TestPusher(self.home)
        pusher.register("push_to_start", START_TOKEN, "com.example.app", "production")
        self.assertFalse(pusher.live_activity_enabled)
        self.assertEqual(await pusher.send_live_activity(LiveActivityPush("start", content_state([]), "s1")), 0)
        self.assertEqual(pusher.fake.calls, [])
        os.environ["LEOAGENT_LIVE_ACTIVITY_PUSH"] = "1"   # 环境变量优先
        self.assertTrue(TestPusher(self.home).live_activity_enabled)
        os.environ["LEOAGENT_LIVE_ACTIVITY_PUSH"] = "0"
        self.assertFalse(TestPusher(self.home).live_activity_enabled)


@unittest.skipUnless(HAS_AIOHTTP, "aiohttp not installed")
class RelayLiveActivityTests(unittest.IsolatedAsyncioTestCase):
    MASTER = "server-key-0123456789"

    async def asyncSetUp(self):
        from .relay import Relay
        self.tmp = tempfile.TemporaryDirectory()
        self.relay = Relay(
            self.MASTER,
            device_keys_path=os.path.join(self.tmp.name, "device-keys.json"),
            treasury_sync_path=os.path.join(self.tmp.name, "treasury.json"),
            treasury_asset_dir=os.path.join(self.tmp.name, "assets"),
        )
        self.pusher = self.relay.apns = RecordingPusher(Path(self.tmp.name))
        self.client = TestClient(TestServer(self.relay.build_app()))
        await self.client.start_server()
        self.sockets = []

    async def asyncTearDown(self):
        for ws in self.sockets:
            await ws.close()
        await self.client.close()
        self.tmp.cleanup()

    def auth(self):
        return {"Authorization": f"Bearer {self.MASTER}"}

    async def mac(self):
        ws = await self.client.ws_connect("/relay/agent")
        self.sockets.append(ws)
        await ws.send_json({"type": "register", "name": "MacBook", "key": self.MASTER, "pin": True, "info": {}})
        await ws.receive(timeout=3)
        return ws

    async def send_event(self, ws, event):
        before = len(self.relay.recent_events)
        await ws.send_json({"type": "event", "event": event})
        for _ in range(300):
            if len(self.relay.recent_events) > before:
                break
            await asyncio.sleep(0.01)
        await asyncio.gather(*list(self.relay._bg_tasks))

    async def test_registered_card_gets_update_and_end(self):
        resp = await self.client.post("/relay/api/device", headers=self.auth(), json={
            "kind": "activity_update", "token": TOKEN_A, "bundle_id": "com.example.app",
            "environment": "development", "session_ids": ["s1"],
            "sessions": [{"session_id": "s1", "title": "🖥 MacBook · Claude"}]})
        self.assertEqual(resp.status, 200)
        bad = await self.client.post("/relay/api/device", headers=self.auth(), json={
            "kind": "activity_update", "token": TOKEN_B, "bundle_id": "x", "environment": "development"})
        self.assertEqual(bad.status, 400)  # 没有会话的 update token 没法路由
        ws = await self.mac()
        await self.send_event(ws, {"event": "approval.request", "session_id": "s1", "tool": "Bash",
                                   "approval_id": "a1"})
        await self.send_event(ws, {"event": "run.completed", "session_id": "s1"})
        events = [(p.event, p.token) for p in self.pusher.live]
        self.assertEqual(events, [("update", TOKEN_A), ("end", TOKEN_A)])
        self.assertEqual(self.pusher.live[0].content_state["sessions"][0]["title"], "🖥 MacBook · Claude")
        # 审批横幅照常发,Live Activity 是额外一条
        self.assertEqual(len(self.pusher.alerts), 2)

    async def test_unattended_approval_card_ends_on_automation_run_completed(self):
        ws = await self.mac()
        await self.send_event(ws, {"event": "approval.request", "session_id": "task-1", "tool": "Bash",
                                   "approval_id": "a1"})
        self.assertEqual([p.event for p in self.pusher.live], ["start"])
        # push-to-start 拉起的卡,iOS 登记它的 update token。
        resp = await self.client.post("/relay/api/device", headers=self.auth(), json={
            "kind": "activity_update", "token": TOKEN_A, "bundle_id": "com.example.app",
            "environment": "development", "session_ids": ["task-1"],
            "sessions": [{"session_id": "task-1", "title": "🖥 MacBook"}]})
        self.assertEqual(resp.status, 200)
        await self.send_event(ws, {"event": "automation.run.completed", "session_id": "task-1",
                                   "status": "succeeded", "run_id": "run-1", "automation_id": "auto-1"})
        self.assertEqual([(p.event, p.token) for p in self.pusher.live], [("start", None), ("end", TOKEN_A)])
        self.assertIsNone(self.pusher.live[-1].alert)
        self.assertNotIn(TOKEN_A, self.relay.live_planner.cards)
        # 审批横幅 + 定时任务完成横幅,Live Activity 不另加提醒。
        self.assertEqual(len(self.pusher.alerts), 2)

    async def test_approval_with_no_card_push_starts_and_kill_switch_stops_it(self):
        ws = await self.mac()
        await self.send_event(ws, {"event": "approval.request", "session_id": "s9", "tool": "Bash"})
        self.assertEqual([p.event for p in self.pusher.live], ["start"])
        self.pusher.live_activity_enabled = False
        await self.send_event(ws, {"event": "approval.request", "session_id": "s10", "tool": "Bash"})
        self.assertEqual([p.event for p in self.pusher.live], ["start"])
        self.assertEqual(len(self.pusher.alerts), 2)  # 关掉 Live Activity 不影响审批通知


class RecordingPusher(APNsPusher):
    """真实的登记/索引逻辑 + 记录发送,不碰网络。"""

    live_activity_enabled = True   # 遮住父类的只读 property,测试里可直接改

    def __init__(self, home):
        super().__init__(home=home)
        self.alerts, self.live = [], []

    @property
    def enabled(self):
        return True

    async def send_alert(self, **kwargs):
        self.alerts.append(kwargs)
        return 1

    async def send_live_activity(self, push, now=None):
        if not self.live_activity_enabled:
            return 0
        self.live.append(push)
        return 1


if __name__ == "__main__":
    unittest.main()
