"""LeoAgent harness manager — drive external coding CLIs as live sessions.

This is ours, not Hermes'. Hermes is an excellent agent engine but it has no
notion of *hosting another agent*: ask it to use Claude Code and the best it
can do is shell out and block until the process exits, with no streaming, no
mid-run steering, and no way to answer a permission prompt from a phone.

A harness here is a long-lived coding CLI that speaks a structured protocol on
its stdio. We spawn it, translate its dialect into one event vocabulary, and
expose control (send / approve / stop) so a phone can drive a real coding agent
running on this Mac.

Design constraints that shaped this file:

* **One event vocabulary.** Each CLI has its own JSON dialect. Translating at
  the edge means the phone client — and any future client — learns one shape.
  We deliberately do NOT translate between vendor *APIs* (the mistake that made
  Cindy's bug reports cluster in its Anthropic↔Responses bridges); we only
  normalise the *event envelope*, and each CLI keeps talking its own protocol
  to its own backend.

* **Events are durable.** Every session appends newline-delimited JSON to a log
  with a monotonic sequence number. A client reconnecting asks for everything
  after seq N. This is the property the Hermes api_server does not have — its
  SSE stream is one-shot and destructive, so a dropped phone connection loses
  events forever. Ours does not.

* **Approvals are first class.** A CLI asking for permission is an event like
  any other, and answering it is an ordinary control call, so the phone and the
  watch can both resolve it.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional


# --------------------------------------------------------------------------
# Event vocabulary — deliberately the same names the phone already renders,
# so one client handles both a Hermes run and a harness session.
# --------------------------------------------------------------------------

EVENT_MESSAGE_DELTA = "message.delta"
EVENT_REASONING = "reasoning.available"
EVENT_TOOL_STARTED = "tool.started"
EVENT_TOOL_COMPLETED = "tool.completed"
EVENT_APPROVAL_REQUEST = "approval.request"
EVENT_APPROVAL_RESPONDED = "approval.responded"
EVENT_USER_MESSAGE = "user.message"
EVENT_SESSION_CREATED = "session.created"
EVENT_RUN_COMPLETED = "run.completed"
EVENT_RUN_FAILED = "run.failed"
EVENT_RUN_CANCELLED = "run.cancelled"

# 慢订阅者被摘除时塞进其队列的哨兵(按身份比较)。读端见到即关流,
# 客户端凭 seq 重连补齐,避免"流活着但永远没数据"的静默悬挂。
_SUBSCRIBER_OVERFLOW: Dict[str, Any] = {"event": "__subscriber.overflow__"}


@dataclass
class HarnessSpec:
    """How to launch one coding CLI and how to read what it says back."""

    key: str
    display_name: str
    executable: str
    # argv after the executable. `{cwd}` is substituted at launch.
    args: List[str]
    # Which translator to use for this CLI's stdout dialect.
    dialect: str
    # A CLI that is not installed simply does not appear; we never offer a
    # harness we cannot actually start.
    def is_available(self) -> bool:
        return shutil.which(self.executable) is not None


# The four the user asked for. Each keeps its own native protocol — no
# cross-vendor API translation, which is where wrapper products get brittle.
HARNESSES: Dict[str, HarnessSpec] = {
    "claude": HarnessSpec(
        key="claude",
        display_name="Claude Code",
        executable="claude",
        args=[
            "-p",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--verbose",
            # Without this, print mode auto-denies any tool needing permission
            # and no control_request ever reaches us — the approval flow this
            # product is built around simply never fires. "stdio" routes
            # can_use_tool requests over the stream-json control protocol.
            "--permission-prompt-tool", "stdio",
        ],
        dialect="claude_stream_json",
    ),
    "codex": HarnessSpec(
        key="codex",
        display_name="Codex CLI",
        executable="codex",
        # 0.14x 起 `codex proto` 要求 TTY,管道模式走 app-server(JSON-RPC
        # over stdio,与 Cindy 桌面端同一条协议)。
        args=["app-server"],
        dialect="codex_app_server",
    ),
    "pi": HarnessSpec(
        key="pi",
        display_name="pi",
        executable="pi",
        args=["--mode", "rpc"],
        dialect="pi_rpc",
    ),
    "grok": HarnessSpec(
        key="grok",
        display_name="Grok CLI",
        executable="grok",
        # 裸 `grok` 是 TUI,无终端直接退出码 1。无头走 ACP over stdio
        # (Agent Client Protocol,JSON-RPC,与 Zed 等客户端同一条协议)。
        args=["agent", "stdio"],
        dialect="grok_acp",
    ),
}


def available_harnesses() -> List[Dict[str, Any]]:
    """What this machine can actually run, for the phone's picker."""
    return [
        {"key": s.key, "name": s.display_name, "executable": s.executable}
        for s in HARNESSES.values()
        if s.is_available()
    ]


# --------------------------------------------------------------------------
# Dialect translation
# --------------------------------------------------------------------------

def _translate_claude(obj: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Claude Code's stream-json → our vocabulary.

    Shapes handled: assistant message content blocks (text / tool_use), tool
    results, and the terminal `result` message. Anything unrecognised is passed
    through as-is under its own type so a client can still show it rather than
    silently dropping a message we have not modelled yet.
    """
    out: List[Dict[str, Any]] = []
    kind = obj.get("type")

    if kind == "assistant":
        for block in (obj.get("message") or {}).get("content") or []:
            btype = block.get("type")
            if btype == "text" and block.get("text"):
                out.append({"event": EVENT_MESSAGE_DELTA, "delta": block["text"]})
            elif btype == "thinking" and block.get("thinking"):
                out.append({"event": EVENT_REASONING, "text": block["thinking"]})
            elif btype == "tool_use":
                preview = json.dumps(block.get("input") or {}, ensure_ascii=False)
                out.append({
                    "event": EVENT_TOOL_STARTED,
                    "tool": block.get("name") or "tool",
                    "preview": preview[:200],
                    "tool_use_id": block.get("id"),
                })

    elif kind == "user":
        # Tool results come back as user-role messages.
        for block in (obj.get("message") or {}).get("content") or []:
            if block.get("type") == "tool_result":
                out.append({
                    "event": EVENT_TOOL_COMPLETED,
                    "tool": "tool",
                    "error": bool(block.get("is_error")),
                    "tool_use_id": block.get("tool_use_id"),
                })

    elif kind == "result":
        if obj.get("is_error"):
            out.append({"event": EVENT_RUN_FAILED, "error": obj.get("result") or "failed"})
        else:
            out.append({
                "event": EVENT_RUN_COMPLETED,
                "output": obj.get("result") or "",
                "usage": obj.get("usage") or {},
            })

    elif kind == "control_request":
        # The CLI's control channel. Only can_use_tool is an approval; other
        # subtypes (hook_callback, mcp_message, …) must pass through untouched
        # or answering them as permissions would corrupt the control protocol.
        req = obj.get("request") or {}
        subtype = req.get("subtype")
        if subtype == "can_use_tool" or "tool_name" in req or "command" in req:
            detail = req.get("input")
            description = req.get("description") or (
                json.dumps(detail, ensure_ascii=False)[:300] if detail else "")
            out.append({
                "event": EVENT_APPROVAL_REQUEST,
                "command": req.get("tool_name") or req.get("command") or "",
                "description": description,
                "choices": ["once", "always", "deny"],
                "request_id": obj.get("request_id"),
                "raw": req,
            })
        else:
            out.append({"event": "harness.control_request", "raw": obj})

    if not out and kind:
        out.append({"event": f"harness.{kind}", "raw": obj})
    return out


def _translate_pi(obj: Dict[str, Any]) -> List[Dict[str, Any]]:
    """pi's RPC events → our vocabulary."""
    out: List[Dict[str, Any]] = []
    kind = obj.get("type")

    if kind == "message_update":
        ev = obj.get("assistantMessageEvent") or {}
        if ev.get("type") == "text_delta" and ev.get("delta"):
            out.append({"event": EVENT_MESSAGE_DELTA, "delta": ev["delta"]})
        elif ev.get("type") == "thinking_delta" and ev.get("delta"):
            out.append({"event": EVENT_REASONING, "text": ev["delta"]})
    elif kind == "tool_execution_start":
        out.append({
            "event": EVENT_TOOL_STARTED,
            "tool": obj.get("toolName") or "tool",
            "preview": json.dumps(obj.get("args") or {}, ensure_ascii=False)[:200],
        })
    elif kind == "tool_execution_end":
        out.append({
            "event": EVENT_TOOL_COMPLETED,
            "tool": obj.get("toolName") or "tool",
            "error": bool(obj.get("isError")),
        })
    elif kind == "extension_ui_request":
        # pi blocks on these, so they are exactly an approval in our terms.
        method = obj.get("method")
        if method in ("confirm", "select"):
            out.append({
                "event": EVENT_APPROVAL_REQUEST,
                "command": str(obj.get("message") or ""),
                "description": "",
                "choices": obj.get("choices") or ["once", "deny"],
                "request_id": obj.get("id"),
                "raw": obj,
            })
    elif kind in ("turn_end", "response"):
        out.append({"event": EVENT_RUN_COMPLETED, "output": obj.get("text") or "", "usage": {}})

    if not out and kind:
        out.append({"event": f"harness.{kind}", "raw": obj})
    return out


def _translate_codex(obj: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Codex CLI's proto stream → our vocabulary.

    Codex's envelope has moved between releases, so this reads defensively:
    known shapes are normalised, everything else is passed through labelled.
    """
    out: List[Dict[str, Any]] = []
    msg = obj.get("msg") if isinstance(obj.get("msg"), dict) else obj
    kind = msg.get("type") or obj.get("type")

    if kind in ("agent_message_delta", "agent_message"):
        text = msg.get("delta") or msg.get("message") or ""
        if text:
            out.append({"event": EVENT_MESSAGE_DELTA, "delta": text})
    elif kind in ("agent_reasoning", "agent_reasoning_delta"):
        text = msg.get("text") or msg.get("delta") or ""
        if text:
            out.append({"event": EVENT_REASONING, "text": text})
    elif kind in ("exec_command_begin", "tool_call_begin"):
        out.append({
            "event": EVENT_TOOL_STARTED,
            "tool": msg.get("tool_name") or "exec",
            "preview": " ".join(msg.get("command") or [])[:200],
        })
    elif kind in ("exec_command_end", "tool_call_end"):
        out.append({
            "event": EVENT_TOOL_COMPLETED,
            "tool": msg.get("tool_name") or "exec",
            "error": bool(msg.get("exit_code")),
        })
    elif kind in ("exec_approval_request", "apply_patch_approval_request"):
        out.append({
            "event": EVENT_APPROVAL_REQUEST,
            "command": " ".join(msg.get("command") or []) or str(msg.get("path") or ""),
            "description": msg.get("reason") or "",
            "choices": ["once", "always", "deny"],
            "request_id": obj.get("id") or msg.get("call_id"),
            "raw": msg,
        })
    elif kind == "task_complete":
        out.append({"event": EVENT_RUN_COMPLETED, "output": msg.get("last_agent_message") or "", "usage": {}})
    elif kind == "error":
        out.append({"event": EVENT_RUN_FAILED, "error": msg.get("message") or "failed"})

    if not out and kind:
        out.append({"event": f"harness.{kind}", "raw": msg})
    return out


def _translate_raw(line: str) -> List[Dict[str, Any]]:
    """For a CLI with no structured protocol: treat stdout as assistant text.

    Honest degradation — no tool events, no approvals, but the output still
    reaches the phone instead of the session being unusable.
    """
    return [{"event": EVENT_MESSAGE_DELTA, "delta": line}]


TRANSLATORS = {
    "claude_stream_json": _translate_claude,
    "pi_rpc": _translate_pi,
    "codex_proto": _translate_codex,
}


# [T-leophone-push] 值得推给手机的事件。
#
# 只推"有行动价值"的:审批要人拍板,终态要人知道结果。message.delta
# 这类进度帧量大且无行动价值,推了只会刷屏、烧配额。
PUSHABLE_EVENTS = {
    EVENT_APPROVAL_REQUEST,
    EVENT_RUN_COMPLETED,
    EVENT_RUN_FAILED,
    EVENT_RUN_CANCELLED,
}

# 外推回调。由 relay_client 在启动时注册——用回调而不是直接 import,
# 是为了避开 harness ↔ relay_client 的循环依赖。
_event_sink = None


def set_event_sink(sink) -> None:
    global _event_sink
    _event_sink = sink


def _push_event(event: Dict[str, Any]) -> None:
    if _event_sink is not None:
        _event_sink(event)



# --------------------------------------------------------------------------
# Session
# --------------------------------------------------------------------------

@dataclass
class HarnessSession:
    """One running coding CLI, with a durable event log."""

    session_id: str
    spec: HarnessSpec
    cwd: str
    log_path: Path
    process: Optional[asyncio.subprocess.Process] = None
    seq: int = 0
    status: str = "starting"
    # Keyed by approval id, not a single slot: a CLI can raise a second
    # approval before the first is answered (parallel tool_use, parallel
    # exec_approval), and a single slot silently answers the wrong one while
    # the first waits forever. Same defect class already fixed on the phone.
    pending_approvals: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    _subscribers: List[asyncio.Queue] = field(default_factory=list)
    _tasks: List[asyncio.Task] = field(default_factory=list)
    # tool_use_id → tool name, so completions can carry the same name the
    # start event did (clients correlate the two to close a running card).
    _tool_names: Dict[str, str] = field(default_factory=dict)
    # codex app-server 方言的会话态:JSON-RPC id 计数、threadId、以及
    # threadId 就绪前排队的用户输入;_outbox 是 translator(同步)托 pump
    # (异步)代写 stdin 的帧队列。
    _rpc_seq: int = 100
    _thread_id: Optional[str] = None
    _pending_inputs: List[str] = field(default_factory=list)
    _outbox: List[Dict[str, Any]] = field(default_factory=list)
    # grok ACP:session/prompt 的请求 id 集合;响应到达即回合结束。
    _acp_prompt_ids: set = field(default_factory=set)

    # -- event fan-out -----------------------------------------------------

    def _emit(self, event: Dict[str, Any]) -> None:
        """Enrich, append to the durable log, then fan out to live subscribers.

        Every enrichment happens BEFORE the log write. The log is what a
        reconnecting client replays, and a replay that differs from what live
        subscribers saw breaks the one guarantee this class exists to provide.
        (approval_id used to be minted after the write — replayed approvals
        arrived unaddressable.)
        """
        self.seq += 1
        event = dict(event)
        event["seq"] = self.seq
        event["session_id"] = self.session_id
        event["timestamp"] = time.time()

        name = event.get("event")
        if name == EVENT_TOOL_STARTED:
            tool_use_id = event.get("tool_use_id")
            if tool_use_id:
                self._tool_names[str(tool_use_id)] = event.get("tool") or "tool"
        elif name == EVENT_TOOL_COMPLETED:
            # Carry the same name the start event did; clients close a running
            # tool card by matching on it.
            tool_use_id = event.get("tool_use_id")
            if tool_use_id and event.get("tool") in (None, "", "tool"):
                event["tool"] = self._tool_names.pop(str(tool_use_id), "tool")
        elif name == EVENT_APPROVAL_REQUEST:
            # Mint an id when the CLI gave none, so every request is
            # addressable even for dialects that omit request_id.
            approval_id = str(event.get("request_id") or f"ap_{uuid.uuid4().hex}")
            event["approval_id"] = approval_id
            self.pending_approvals[approval_id] = event
            self.status = "waiting_for_approval"
        elif name == EVENT_APPROVAL_RESPONDED:
            answered = event.get("approval_id")
            if answered:
                self.pending_approvals.pop(answered, None)
            if not self.pending_approvals:
                self.status = "running"
        elif name in (EVENT_RUN_COMPLETED, EVENT_RUN_FAILED):
            # stream-json CLIs stay alive between turns; a finished turn means
            # "idle and steerable", not "session over". Terminal statuses are
            # only set by process exit (_pump_stdout) and stop().
            if self.process is not None and self.process.returncode is None \
                    and self.status not in ("cancelled", "completed", "failed"):
                self.status = "idle"

        # 0600 before the first write: the log carries raw CLI stdout/stderr,
        # which can contain tokens the CLI happened to print. The write is
        # guarded: a full disk must degrade the durable log, not kill the
        # stdout pump — an unpumped pipe blocks the CLI forever.
        try:
            if not self.log_path.exists():
                self.log_path.touch(mode=0o600)
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(event, ensure_ascii=False) + "\n")
        except OSError:
            pass

        # [T-leophone-push] 关键事件外推给中继。放在持久化之后:推出去的
        # 必须是已落盘、带 seq 与 approval_id 的富化帧,中继与手机才能按
        # seq 幂等合并。外推是尽力而为,绝不能影响本地流。
        if name in PUSHABLE_EVENTS:
            try:
                _push_event(event)
            except Exception:  # noqa: BLE001
                pass

        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # A stalled subscriber is dropped rather than allowed to block
                # the session; it can catch up from the log by seq. 摘除时必须
                # 让对端"知道"被摘了:否则 subscribe 排空残余后会永远挂在
                # queue.get() 上——流活着但再无数据,客户端要等到自己的读超时
                # (经中继最长 1 小时)才会重连。腾一格塞哨兵,让流立刻关闭,
                # 客户端按 seq 重连补齐,被顶掉的那条也在补齐范围内。
                self._subscribers.remove(queue)
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(_SUBSCRIBER_OVERFLOW)
                except asyncio.QueueFull:
                    pass

    def replay(self, after_seq: int = 0) -> List[Dict[str, Any]]:
        """Everything since `after_seq`. This is what makes a phone that lost
        its connection able to catch up exactly, with no gap and no repeat."""
        if not self.log_path.exists():
            return []
        events: List[Dict[str, Any]] = []
        with self.log_path.open(encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if event.get("seq", 0) > after_seq:
                    events.append(event)
        return events

    async def subscribe(self, after_seq: int = 0) -> AsyncIterator[Dict[str, Any]]:
        """Replay-then-follow, with no gap at the seam.

        The queue is attached BEFORE the log is read. Doing it the other way
        round loses anything produced while the replay was being written out:
        such an event is already in the log (too late for this replay) but not
        yet in any queue — permanently invisible to this connection, which is
        exactly the guarantee this class exists to provide. Live events that
        the replay also covered are dropped by seq.
        """
        queue: asyncio.Queue = asyncio.Queue(maxsize=512)
        self._subscribers.append(queue)
        highest = after_seq
        try:
            for event in self.replay(after_seq):
                highest = max(highest, event.get("seq", 0))
                yield event
            # A session that already ended has nothing live to follow. Without
            # this, a client reattaching to a finished session replays fine and
            # then parks on the queue until its own timeout — up to an hour of
            # dead socket.
            if self.status in ("completed", "failed", "cancelled", "orphaned"):
                return
            while True:
                event = await queue.get()
                if event is _SUBSCRIBER_OVERFLOW:
                    # 本订阅被 _emit 判定为慢消费者摘除了。立即关流,让客户端
                    # 走重连+replay(after_seq) 补齐,而不是在空队列上挂到超时。
                    return
                if event.get("seq", 0) <= highest:
                    continue  # already delivered by the replay above
                highest = event.get("seq", highest)
                yield event
                if event.get("event") in (EVENT_RUN_COMPLETED, EVENT_RUN_FAILED, EVENT_RUN_CANCELLED):
                    if self.status in ("completed", "failed", "cancelled"):
                        return
        finally:
            if queue in self._subscribers:
                self._subscribers.remove(queue)

    # -- lifecycle ---------------------------------------------------------

    # ── codex app-server 方言(JSON-RPC 2.0 over stdio)────────────────────

    def _next_rpc_id(self) -> int:
        self._rpc_seq += 1
        return self._rpc_seq

    def _app_server_handshake(self) -> List[Dict[str, Any]]:
        """启动帧:initialize + thread/start(threadId 从响应/通知里捕获)。"""
        return [
            {"jsonrpc": "2.0", "id": self._next_rpc_id(), "method": "initialize",
             "params": {"clientInfo": {"name": "leoagent", "version": "0.2.0"}}},
            {"jsonrpc": "2.0", "id": self._next_rpc_id(), "method": "thread/start",
             "params": {"cwd": self.cwd}},
        ]

    def _turn_start_frame(self, text: str) -> Dict[str, Any]:
        return {"jsonrpc": "2.0", "id": self._next_rpc_id(), "method": "turn/start",
                "params": {"threadId": self._thread_id,
                           "input": [{"type": "text", "text": text}]}}

    def _translate_app_server(self, obj: Dict[str, Any]) -> List[Dict[str, Any]]:
        """codex app-server 帧 → 事件词汇表。有状态,所以是实例方法。

        server→client 的带 id 请求(审批类)转成 approval.request;threadId
        一旦就绪就 flush 排队的输入(帧进 _outbox,由 pump 代写)。
        """
        out: List[Dict[str, Any]] = []
        method = obj.get("method")
        params = obj.get("params") or {}

        def capture_thread(thread_id: Optional[str]) -> None:
            if thread_id and not self._thread_id:
                self._thread_id = str(thread_id)
                for queued in self._pending_inputs:
                    self._outbox.append(self._turn_start_frame(queued))
                self._pending_inputs.clear()

        if method is None:
            # 我们发出的请求的响应
            result = obj.get("result") or {}
            if isinstance(result, dict):
                capture_thread(result.get("threadId")
                               or (result.get("thread") or {}).get("id"))
            if obj.get("error"):
                out.append({"event": "harness.stderr",
                            "text": f"rpc error: {json.dumps(obj['error'], ensure_ascii=False)[:200]}"})
            return out

        if "id" in obj:
            # server→client 请求。审批类转审批;其余礼貌拒绝,免得对端挂等。
            if method in ("item/commandExecution/requestApproval",
                          "item/fileChange/requestApproval",
                          "item/permissions/requestApproval"):
                item = params.get("item") or {}
                command = item.get("command") or params.get("reason") or method.split("/")[1]
                out.append({
                    "event": EVENT_APPROVAL_REQUEST,
                    "command": str(command)[:300],
                    "description": str(params.get("reason") or ""),
                    "choices": ["once", "always", "deny"],
                    "request_id": obj.get("id"),
                    "raw": params,
                })
            else:
                self._outbox.append({"jsonrpc": "2.0", "id": obj.get("id"),
                                     "error": {"code": -32601,
                                               "message": f"unsupported: {method}"}})
                out.append({"event": "harness.control_request", "raw": {"method": method}})
            return out

        # 通知
        if method == "thread/started":
            capture_thread(params.get("threadId")
                           or (params.get("thread") or {}).get("id"))
        elif method in ("item/reasoning/textDelta", "item/reasoning/summaryTextDelta"):
            delta = params.get("delta")
            if delta:
                out.append({"event": EVENT_REASONING, "text": delta})
        elif method in ("item/started", "item/updated", "item/completed"):
            item = params.get("item") or {}
            item_type = item.get("type")
            item_id = item.get("id")
            if item_type == "agentMessage" and method == "item/completed":
                text = item.get("text")
                if text:
                    out.append({"event": EVENT_MESSAGE_DELTA, "delta": text})
            elif item_type == "commandExecution":
                if method == "item/started":
                    out.append({"event": EVENT_TOOL_STARTED, "tool": "exec",
                                "preview": str(item.get("command") or "")[:200],
                                "tool_use_id": item_id})
                elif method == "item/completed":
                    exit_code = item.get("exitCode")
                    out.append({"event": EVENT_TOOL_COMPLETED, "tool": "exec",
                                "error": bool(exit_code), "tool_use_id": item_id})
            elif item_type == "fileChange" and method == "item/completed":
                out.append({"event": EVENT_TOOL_COMPLETED, "tool": "edit",
                            "error": False, "tool_use_id": item_id})
        elif method == "turn/completed":
            out.append({"event": EVENT_RUN_COMPLETED, "output": "", "usage": {}})
        elif method == "error":
            out.append({"event": EVENT_RUN_FAILED,
                        "error": str(params.get("message") or "error")})
        # 其余通知(status/tokenUsage/…)不进转录,保持日志干净
        return out

    # -- grok ACP(Agent Client Protocol over stdio)------------------------
    # 实测帧型(grok 0.2.118):session/new 响应带 result.sessionId;流式
    # 更新是 session/update 通知,params.update.sessionUpdate 区分种类;
    # 审批是 server→client 请求 session/request_permission,带 options 列表。

    def _acp_handshake(self) -> List[Dict[str, Any]]:
        return [
            {"jsonrpc": "2.0", "id": self._next_rpc_id(), "method": "initialize",
             "params": {"protocolVersion": 1,
                        "clientCapabilities": {"fs": {"readTextFile": False,
                                                      "writeTextFile": False}}}},
            {"jsonrpc": "2.0", "id": self._next_rpc_id(), "method": "session/new",
             "params": {"cwd": self.cwd, "mcpServers": []}},
        ]

    def _acp_prompt_frame(self, text: str) -> Dict[str, Any]:
        rpc_id = self._next_rpc_id()
        self._acp_prompt_ids.add(rpc_id)
        return {"jsonrpc": "2.0", "id": rpc_id, "method": "session/prompt",
                "params": {"sessionId": self._thread_id,
                           "prompt": [{"type": "text", "text": text}]}}

    def _translate_acp(self, obj: Dict[str, Any]) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        method = obj.get("method")
        params = obj.get("params") or {}

        if method is None:
            # 我们发出的请求的响应
            result = obj.get("result")
            if isinstance(result, dict) and result.get("sessionId") and not self._thread_id:
                self._thread_id = str(result["sessionId"])
                for queued in self._pending_inputs:
                    self._outbox.append(self._acp_prompt_frame(queued))
                self._pending_inputs.clear()
            rpc_id = obj.get("id")
            if rpc_id in self._acp_prompt_ids:
                self._acp_prompt_ids.discard(rpc_id)
                if obj.get("error"):
                    out.append({"event": EVENT_RUN_FAILED,
                                "error": str(obj["error"].get("message") or "error")})
                else:
                    out.append({"event": EVENT_RUN_COMPLETED, "output": "", "usage": {}})
            elif obj.get("error"):
                out.append({"event": "harness.stderr",
                            "text": f"rpc error: {json.dumps(obj['error'], ensure_ascii=False)[:200]}"})
            return out

        if "id" in obj:
            # server→client 请求
            if method == "session/request_permission":
                tool_call = params.get("toolCall") or {}
                options = params.get("options") or []
                out.append({
                    "event": EVENT_APPROVAL_REQUEST,
                    "command": str(tool_call.get("title") or tool_call.get("kind") or "工具调用")[:300],
                    "description": "",
                    "choices": ["once", "always", "deny"],
                    "request_id": obj.get("id"),
                    "raw": {"options": options},
                })
            else:
                self._outbox.append({"jsonrpc": "2.0", "id": obj.get("id"),
                                     "error": {"code": -32601,
                                               "message": f"unsupported: {method}"}})
                out.append({"event": "harness.control_request", "raw": {"method": method}})
            return out

        # 通知。x.ai 私有频道(公告/MCP 列表)不进转录。
        if method != "session/update":
            return out
        update = params.get("update") or {}
        kind = update.get("sessionUpdate")
        content = update.get("content") or {}
        text = content.get("text") if isinstance(content, dict) else None
        if kind == "agent_message_chunk" and text:
            out.append({"event": EVENT_MESSAGE_DELTA, "delta": text})
        elif kind == "agent_thought_chunk" and text:
            out.append({"event": EVENT_REASONING, "text": text})
        elif kind == "tool_call":
            out.append({"event": EVENT_TOOL_STARTED,
                        "tool": str(update.get("kind") or "tool"),
                        "preview": str(update.get("title") or "")[:200],
                        "tool_use_id": update.get("toolCallId")})
        elif kind == "tool_call_update":
            status = update.get("status")
            if status in ("completed", "failed"):
                out.append({"event": EVENT_TOOL_COMPLETED,
                            "tool": str(update.get("kind") or "tool"),
                            "error": status == "failed",
                            "tool_use_id": update.get("toolCallId")})
        # user_message_chunk 是自己输入的回显,plan/available_commands 不进转录
        return out

    async def _flush_outbox(self) -> None:
        if not self.process or not self.process.stdin:
            self._outbox.clear()
            return
        while self._outbox:
            frame = self._outbox.pop(0)
            self.process.stdin.write(
                (json.dumps(frame, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()

    async def start(self) -> None:
        env = dict(os.environ)
        env.setdefault("TERM", "dumb")
        # The key guards every session on this Mac. The CLIs we spawn run
        # arbitrary shell commands by design; handing them the key would let
        # any session drive every other one.
        env.pop("LEOAGENT_KEY", None)
        args = [arg.replace("{cwd}", self.cwd) for arg in self.spec.args]
        self.process = await asyncio.create_subprocess_exec(
            self.spec.executable, *args,
            cwd=self.cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            # asyncio 默认单行 64KiB;codex app-server 的 thread/start 响应
            # (完整 thread 对象)轻松超限,readline 会抛 LimitOverrunError
            # 直接杀死读循环——症状是会话建了却永远没有第一条回复。
            limit=16 * 1024 * 1024,
        )
        self.status = "running"
        # Hold strong references: an un-referenced Task can be garbage
        # collected mid-flight, which would stop the reader silently.
        self._tasks = [
            asyncio.create_task(self._pump_stdout()),
            asyncio.create_task(self._pump_stderr()),
        ]
        if self.spec.dialect == "codex_app_server":
            self._outbox.extend(self._app_server_handshake())
            await self._flush_outbox()
        elif self.spec.dialect == "grok_acp":
            self._outbox.extend(self._acp_handshake())
            await self._flush_outbox()

    async def _pump_stdout(self) -> None:
        assert self.process and self.process.stdout
        if self.spec.dialect == "codex_app_server":
            translate = self._translate_app_server
        elif self.spec.dialect == "grok_acp":
            translate = self._translate_acp
        else:
            translate = TRANSLATORS.get(self.spec.dialect)
        while True:
            try:
                raw = await self.process.stdout.readline()
            except (asyncio.LimitOverrunError, ValueError) as exc:
                # 超长行:丢弃这一帧但绝不让读循环死掉(读循环一死,子进程
                # stdout 管道塞满后整个 CLI 卡死,而状态还显示 running)。
                self._emit({"event": "harness.stderr",
                            "text": f"oversized frame dropped: {exc}"})
                continue
            if not raw:
                break
            # Split on \n only. Never use a reader that also breaks on U+2028 /
            # U+2029 — those are legal inside JSON strings and splitting on them
            # corrupts the frame (pi's own RPC docs call this out explicitly).
            line = raw.decode("utf-8", errors="replace").rstrip("\n")
            if not line.strip():
                continue
            if translate is None:
                for event in _translate_raw(line):
                    self._emit(event)
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                # Non-JSON on a structured channel is usually a banner or a
                # warning; surface it rather than hiding it.
                self._emit({"event": "harness.stdout", "text": line})
                continue
            try:
                translated = translate(obj)
            except Exception as exc:
                # A malformed frame must never kill the reader: if this loop
                # dies, nobody drains the child's stdout, its pipe fills at
                # ~64KB and the CLI blocks forever on write() — the session
                # hangs with status still "running" and no further events.
                translated = [{"event": "harness.translate_error",
                               "text": f"{type(exc).__name__}: {exc}", "raw": line[:500]}]
            for event in translated:
                self._emit(event)
            if self._outbox:
                # translator(同步)排的帧在这里代写:threadId 就绪后的排队
                # 输入、对不支持的 server 请求的拒绝响应。
                try:
                    await self._flush_outbox()
                except (BrokenPipeError, ConnectionResetError):
                    pass

        code = await self.process.wait() if self.process else -1
        if self.status not in ("completed", "failed", "cancelled"):
            if code == 0:
                self.status = "completed"
                self._emit({"event": EVENT_RUN_COMPLETED, "output": "", "usage": {}})
            else:
                self.status = "failed"
                self._emit({"event": EVENT_RUN_FAILED, "error": f"exited with code {code}"})

    async def _pump_stderr(self) -> None:
        assert self.process and self.process.stderr
        while True:
            raw = await self.process.stderr.readline()
            if not raw:
                break
            text = raw.decode("utf-8", errors="replace").rstrip("\n")
            if text.strip():
                self._emit({"event": "harness.stderr", "text": text})

    async def send(self, text: str) -> None:
        """Steer a running session with a follow-up instruction."""
        if not self.process or not self.process.stdin:
            raise RuntimeError("session is not running")
        if self.spec.dialect in ("codex_app_server", "grok_acp"):
            if self._thread_id:
                frame = (self._turn_start_frame(text)
                         if self.spec.dialect == "codex_app_server"
                         else self._acp_prompt_frame(text))
                self._outbox.append(frame)
                await self._flush_outbox()
            else:
                # 会话 id 还没回来:排队,id 一到由 pump 代发。
                self._pending_inputs.append(text)
            if self.status == "idle":
                self.status = "running"
            self._emit({"event": EVENT_USER_MESSAGE, "text": text})
            return
        if self.spec.dialect == "claude_stream_json":
            payload = {
                "type": "user",
                "message": {"role": "user", "content": [{"type": "text", "text": text}]},
            }
        elif self.spec.dialect == "pi_rpc":
            payload = {"id": str(uuid.uuid4()), "type": "prompt", "message": text}
        elif self.spec.dialect == "codex_proto":
            payload = {"id": str(uuid.uuid4()), "op": {"type": "user_input",
                                                       "items": [{"type": "text", "text": text}]}}
        else:
            payload = None
        if payload is None:
            self.process.stdin.write((text + "\n").encode("utf-8"))
        else:
            self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()
        if self.status == "idle":
            self.status = "running"
        # Into the durable log too: without this the conversation's user half
        # exists only on whichever client happened to type it, and a reconnect
        # replays a transcript of answers with no questions.
        self._emit({"event": EVENT_USER_MESSAGE, "text": text})

    async def respond_to_approval(self, choice: str, approval_id: Optional[str] = None) -> bool:
        """Answer one specific pending approval in the CLI's own dialect.

        Returns True only when the answer actually reached the CLI's stdin.
        Everything else keeps the approval pending — reporting success for an
        answer that went nowhere leaves the client showing "resolved" while
        the CLI blocks forever.
        """
        if approval_id:
            pending = self.pending_approvals.get(approval_id)
        elif len(self.pending_approvals) == 1:
            # Unambiguous: exactly one outstanding request.
            approval_id, pending = next(iter(self.pending_approvals.items()))
        else:
            pending = None
        if not pending or not self.process or not self.process.stdin:
            return False
        request_id = pending.get("request_id")
        if request_id is None and self.spec.dialect in (
                "claude_stream_json", "pi_rpc", "codex_proto", "codex_app_server",
                "grok_acp"):
            # A minted id is addressable by clients but not routable to the
            # CLI; pretending otherwise clears the card while the CLI waits.
            return False
        # Deny by default: dialects can supply their own choice labels, and an
        # unrecognised label must never read as consent.
        allowed = choice in ("once", "always", "yes", "approve", "allow")

        if self.spec.dialect == "claude_stream_json":
            # Agent-SDK control protocol shape: subtype + request_id inside
            # the response envelope. The flat shape is silently ignored by
            # the CLI, which is an approval that never lands.
            inner: Dict[str, Any] = {"behavior": "allow" if allowed else "deny"}
            if not allowed:
                inner["message"] = "denied by operator"
            elif choice == "always":
                suggestions = (pending.get("raw") or {}).get("permission_suggestions")
                if suggestions:
                    inner["updatedPermissions"] = suggestions
            payload = {
                "type": "control_response",
                "response": {"subtype": "success", "request_id": request_id,
                             "response": inner},
            }
        elif self.spec.dialect == "pi_rpc":
            # A `select` prompt supplied its own labels and wants one back; a
            # `confirm` prompt wants a boolean.
            cli_choices = (pending.get("raw") or {}).get("choices")
            if cli_choices and choice in cli_choices:
                result: Any = choice
            else:
                result = allowed
            payload = {"id": request_id, "type": "extension_ui_response", "result": result}
        elif self.spec.dialect == "codex_proto":
            decision = {"once": "approved", "always": "approved_for_session", "deny": "denied"}.get(choice, "denied")
            payload = {"id": str(uuid.uuid4()),
                       "op": {"type": "exec_approval", "id": request_id, "decision": decision}}
        elif self.spec.dialect == "codex_app_server":
            decision = {"once": "accept", "always": "acceptForSession",
                        "deny": "decline"}.get(choice, "decline")
            payload = {"jsonrpc": "2.0", "id": request_id,
                       "result": {"decision": decision}}
        elif self.spec.dialect == "grok_acp":
            # 选项 id 由 CLI 提供(kind: allow_once/allow_always/reject_once…),
            # 按语义挑;找不到就退回第一个 reject,绝不误放行。
            options = (pending.get("raw") or {}).get("options") or []
            want = {"once": "allow_once", "always": "allow_always",
                    "deny": "reject_once"}.get(choice, "reject_once")
            option_id = None
            for opt in options:
                if opt.get("kind") == want:
                    option_id = opt.get("optionId")
                    break
            if option_id is None:
                for opt in options:
                    if str(opt.get("kind") or "").startswith(
                            "allow" if allowed else "reject"):
                        option_id = opt.get("optionId")
                        break
            if option_id is None:
                return False
            payload = {"jsonrpc": "2.0", "id": request_id,
                       "result": {"outcome": {"outcome": "selected",
                                              "optionId": option_id}}}
        else:
            return False

        self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()
        self._emit({"event": EVENT_APPROVAL_RESPONDED, "choice": choice, "approval_id": approval_id})
        return True

    async def stop(self) -> None:
        if not self.process:
            return
        self.status = "cancelled"
        try:
            self.process.terminate()
        except ProcessLookupError:
            pass
        else:
            # A CLI with cleanup logic may ignore SIGTERM; without this the
            # status says "cancelled" while the process runs on forever.
            try:
                await asyncio.wait_for(self.process.wait(), timeout=5)
            except asyncio.TimeoutError:
                try:
                    self.process.kill()
                except ProcessLookupError:
                    pass
        self._emit({"event": EVENT_RUN_CANCELLED})


class HarnessManager:
    """All harness sessions on this machine."""

    # A personal machine hosting more live coding agents than this is a bug,
    # not a workload; the cap turns a runaway client into a clean 400.
    MAX_LIVE_SESSIONS = 16

    def __init__(self, home: Optional[Path] = None):
        self.home = home or Path.home() / ".leoagent"
        self.sessions_dir = self.home / "harness-sessions"
        self.sessions_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            # mkdir applies mode= to the leaf only; the parent holds the key
            # file and must be tightened explicitly.
            self.home.chmod(0o700)
            self.sessions_dir.chmod(0o700)   # tighten a pre-existing directory
        except OSError:
            pass
        self.sessions: Dict[str, HarnessSession] = {}
        self._rehydrate()

    def _rehydrate(self) -> None:
        """Surface previous-boot sessions from their logs, read-only.

        The durable log is the whole point of this service; a restart that
        404s every old session breaks that promise. These sessions cannot be
        steered (their process died with the old daemon) but their history
        replays exactly.
        """
        for log_path in sorted(self.sessions_dir.glob("hs_*.ndjson")):
            session_id = log_path.stem
            harness_key, cwd, last_seq = "?", "?", 0
            try:
                with log_path.open(encoding="utf-8") as handle:
                    for line in handle:
                        try:
                            event = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        last_seq = max(last_seq, int(event.get("seq") or 0))
                        if event.get("event") == EVENT_SESSION_CREATED:
                            harness_key = event.get("harness") or "?"
                            cwd = event.get("cwd") or "?"
            except OSError:
                continue
            spec = HARNESSES.get(harness_key) or HarnessSpec(
                key=harness_key, display_name=harness_key,
                executable="", args=[], dialect="none")
            self.sessions[session_id] = HarnessSession(
                session_id=session_id, spec=spec, cwd=cwd,
                log_path=log_path, process=None, seq=last_seq,
                status="orphaned")

    def _live_count(self) -> int:
        return sum(1 for s in self.sessions.values()
                   if s.status in ("starting", "running", "idle", "waiting_for_approval"))

    async def create(self, harness: str, cwd: str, prompt: Optional[str] = None) -> HarnessSession:
        spec = HARNESSES.get(harness)
        if spec is None:
            raise ValueError(f"unknown harness: {harness}")
        if not spec.is_available():
            raise RuntimeError(f"{spec.display_name} is not installed on this machine")
        work_dir = os.path.expanduser(cwd)
        if not os.path.isdir(work_dir):
            raise ValueError(f"not a directory: {cwd}")
        if self._live_count() >= self.MAX_LIVE_SESSIONS:
            raise RuntimeError(f"too many live sessions (max {self.MAX_LIVE_SESSIONS})")

        session_id = f"hs_{uuid.uuid4().hex}"
        session = HarnessSession(
            session_id=session_id,
            spec=spec,
            cwd=work_dir,
            log_path=self.sessions_dir / f"{session_id}.ndjson",
        )
        # First line of the log names the session, so a rehydrated one still
        # knows what it was. Registration happens only after a successful
        # start: a spawn failure must not leave a permanent zombie entry.
        session._emit({"event": EVENT_SESSION_CREATED, "harness": spec.key,
                       "name": spec.display_name, "cwd": work_dir})
        try:
            await session.start()
            if prompt:
                await session.send(prompt)
        except OSError as exc:
            # start() 成功但 send(prompt) 失败时,子进程已 spawn、pump 已在跑:
            # 必须先 stop 收割,否则进程既不在 sessions 里(shutdown_all 够不着)
            # 又活着,daemon 退出后成孤儿;pump 还会把刚删的日志重建出来。
            try:
                await session.stop()
            except Exception:  # noqa: BLE001
                pass
            try:
                log_path = self.sessions_dir / f"{session_id}.ndjson"
                log_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise RuntimeError(f"failed to start {spec.display_name}: {exc}") from exc
        self.sessions[session_id] = session
        return session

    async def shutdown_all(self) -> None:
        """Reap every child before the daemon exits. A restart that orphans
        detached CLIs leaves them holding working directories forever."""
        live = [s for s in self.sessions.values()
                if s.process is not None and s.process.returncode is None]
        if live:
            await asyncio.gather(*(s.stop() for s in live), return_exceptions=True)

    def get(self, session_id: str) -> Optional[HarnessSession]:
        return self.sessions.get(session_id)

    def list(self) -> List[Dict[str, Any]]:
        return [
            {
                "session_id": s.session_id,
                "harness": s.spec.key,
                "name": s.spec.display_name,
                "cwd": s.cwd,
                "status": s.status,
                "seq": s.seq,
                "waiting_for_approval": bool(s.pending_approvals),
                "pending_approvals": [
                    {"approval_id": k, "command": v.get("command", ""),
                     "choices": v.get("choices", [])}
                    for k, v in s.pending_approvals.items()
                ],
            }
            for s in self.sessions.values()
        ]
