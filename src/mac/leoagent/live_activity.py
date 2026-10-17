"""Live Activity 远程推送的纯逻辑(WP-41):中继事件 → ActivityKit content-state。

为什么在中继:App 被杀/挂起时,手机上没有任何代码在跑,灵动岛只能靠 APNs
`apns-push-type: liveactivity` 推送来启动(push-to-start)、更新、结束。Mac 把关键
事件交给中继(`kind == "event"` 帧),这里决定要不要动灵动岛、动成什么样。

这里不碰网络,只产出「对哪类 token、发 start/update/end、带什么 content-state」,
方便单测。字段名必须与 iOS `AgentActivityAttributes.ContentState` /
`LiveSessionSnapshot` 一字不差(iOS 端解码对缺键宽容,但多余/拼错的键会被忽略)。
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# iOS `LiveSessionSnapshot.approvalIcon`:锁屏卡/灵动岛按这个图标认「等你批准」。
APPROVAL_ICON = "hand.raised.fill"
RUNNING_ICON = "terminal.fill"
DONE_ICON = "checkmark.circle"

ATTRIBUTES_TYPE = "AgentActivityAttributes"

# Foundation 默认的 Date 编码是「距 2001-01-01 的秒数」(deferredToDate)。
APPLE_REFERENCE_EPOCH = 978307200.0

# 运行中的卡多久没更新就让系统标灰(中继或 Mac 掉线时不至于一直显示"运行中")。
STALE_AFTER_S = 30 * 60
# 完成后卡片停留多久再收起。
DISMISS_AFTER_S = 5

START_EVENTS = {"session.created", "run.started", "turn.started"}
END_OUTCOMES = {"run.completed": "done", "run.failed": "attention", "run.cancelled": "stopped"}

# ContentState 里的字符串上限,与 iOS `cappedForPayload()` 一致(4KB 硬上限)。
MAX_TITLE = 24
MAX_TOOL_STATUS = 32
MAX_LAST_MESSAGE = 40
MAX_ROWS = 4


def apple_date(unix_ts: float) -> float:
    return round(unix_ts - APPLE_REFERENCE_EPOCH, 3)


def _cap(text: str, limit: int) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def snapshot(session_id: str, title: str, *, icon: str, status: str,
             completed: bool = False, last_message: str = "", outcome: str = "done") -> Dict[str, Any]:
    return {
        "sessionId": session_id[:64],
        "title": _cap(title, MAX_TITLE),
        "toolIcon": icon,
        "toolStatus": _cap(status, MAX_TOOL_STATUS),
        "loopIteration": 0,
        "isCompleted": completed,
        "lastMessage": _cap(last_message, MAX_LAST_MESSAGE),
        "outcome": outcome,
    }


def content_state(sessions: List[Dict[str, Any]]) -> Dict[str, Any]:
    rows = sessions[:MAX_ROWS]
    running = [s for s in rows if not s.get("isCompleted")]
    latest = running[0]["toolIcon"] if running else (rows[0]["toolIcon"] if rows else "")
    return {
        "activeSessionCount": len(running),
        "sessions": rows,
        "carouselIndex": 0,
        "soulName": "",
        "latestToolIcon": latest,
        "minimalShowsTool": False,
        "allCompleted": bool(rows) and not running,
        "isAudioPlaying": False,
        "isAudioLoaded": False,
        "audioTitle": "",
        "privacyMode": False,
    }


@dataclass
class LiveActivityPush:
    """一次要发的 Live Activity 推送。target = 'start'(push-to-start token)或某个 update token。"""
    event: str                      # start | update | end
    content_state: Dict[str, Any]
    session_id: str
    alert: Optional[Dict[str, str]] = None
    attributes: Optional[Dict[str, Any]] = None
    stale_date: Optional[int] = None
    dismissal_date: Optional[int] = None
    priority: int = 10
    token: Optional[str] = None     # None = 发给所有 push-to-start token


@dataclass
class LiveActivityPlanner:
    """按 update token 记住卡上每个会话的最新样子,事件来了据此算整张卡的 content-state。

    一张卡可能挂着同一台手机关注的多个 Mac 会话(iOS 一个 App 只开一个 Agent
    活动)。远程 update 会整体替换 content-state,只改事件对应的那一行,其他行照旧。
    """
    # token -> {session_id: snapshot}
    cards: Dict[str, Dict[str, Dict[str, Any]]] = field(default_factory=dict)
    # 最近发过 push-to-start 的会话:同一会话 10 分钟内不重复拉起第二张卡。
    started: Dict[str, float] = field(default_factory=dict)
    restart_guard_s: float = 600.0

    def bind(self, token: str, sessions: List[Dict[str, str]]) -> None:
        """iOS 登记 update token 时带上卡上已有的会话(session_id + title)。"""
        card = self.cards.setdefault(token, {})
        for item in sessions[:MAX_ROWS]:
            sid = str(item.get("session_id") or "").strip()
            if not sid or sid in card:
                continue
            card[sid] = snapshot(sid, str(item.get("title") or "Mac"), icon=RUNNING_ICON, status="运行中…")

    def forget(self, token: str) -> None:
        self.cards.pop(token, None)

    def plan(self, kind: str, machine: str, event: Dict[str, Any],
             update_tokens: Dict[str, List[str]], now: Optional[float] = None) -> List[LiveActivityPush]:
        """update_tokens: session_id -> [update token, ...](来自设备登记)。"""
        now = time.time() if now is None else now
        sid = str(event.get("session_id") or "").strip()
        if not sid:
            return []
        title = f"🖥 {machine}"
        alert = None
        if kind == "approval.request":
            tool = str(event.get("tool") or "一条命令")[:40]
            # 锁屏只写工具名,与审批通知同一口径:命令里可能带密钥。
            row = snapshot(sid, title, icon=APPROVAL_ICON, status=f"等你审批:{tool}")
            alert = {"title": "需要你批准", "body": f"{machine} · {tool}"}
        elif kind == "approval.resolved" or kind in START_EVENTS:
            row = snapshot(sid, title, icon=RUNNING_ICON, status="运行中…")
        elif kind in END_OUTCOMES:
            outcome = END_OUTCOMES[kind]
            message = {"done": "任务已完成", "attention": "任务出错,打开 App 查看", "stopped": "任务已停止"}[outcome]
            row = snapshot(sid, title, icon=DONE_ICON, status=message, completed=True,
                           last_message=message, outcome=outcome)
        else:
            return []

        pushes: List[LiveActivityPush] = []
        tokens = update_tokens.get(sid) or []
        for token in tokens:
            card = self.cards.setdefault(token, {})
            if sid not in card and kind in END_OUTCOMES:
                # 卡上没有这个会话:它的结束与这张卡无关。
                continue
            card[sid] = {**card.get(sid, {}), **row, "title": card.get(sid, {}).get("title") or row["title"]}
            state = content_state(list(card.values()))
            if state["allCompleted"]:
                pushes.append(LiveActivityPush("end", state, sid, token=token,
                                               dismissal_date=int(now + DISMISS_AFTER_S)))
            else:
                pushes.append(LiveActivityPush("update", state, sid, alert=alert, token=token,
                                               stale_date=int(now + STALE_AFTER_S),
                                               # 例行进度用 5 不占预算;审批要立刻亮屏
                                               priority=10 if alert else 5))
        if tokens or kind in END_OUTCOMES:
            return pushes
        # 这台手机还没有这张卡(App 被杀、或卡被划掉):审批/开跑时远程拉起一张。
        last = self.started.get(sid)
        if last is not None and now - last < self.restart_guard_s:
            return []
        self.started[sid] = now
        state = content_state([row])
        return [LiveActivityPush("start", state, sid, alert=alert,
                                 attributes={"startDate": apple_date(now), "origin": "relay"},
                                 stale_date=int(now + STALE_AFTER_S))]


def aps_payload(push: LiveActivityPush, now: Optional[float] = None) -> Dict[str, Any]:
    now = time.time() if now is None else now
    aps: Dict[str, Any] = {
        "timestamp": int(now),
        "event": push.event,
        "content-state": push.content_state,
    }
    if push.event == "start":
        aps["attributes-type"] = ATTRIBUTES_TYPE
        aps["attributes"] = push.attributes or {"startDate": apple_date(now)}
    if push.alert:
        aps["alert"] = {"title": push.alert.get("title", ""), "body": push.alert.get("body", "")}
        aps["sound"] = "default"
    if push.stale_date is not None:
        aps["stale-date"] = push.stale_date
    if push.dismissal_date is not None:
        aps["dismissal-date"] = push.dismissal_date
    return {"aps": aps}
