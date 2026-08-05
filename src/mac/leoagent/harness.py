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
EVENT_RUN_COMPLETED = "run.completed"
EVENT_RUN_FAILED = "run.failed"
EVENT_RUN_CANCELLED = "run.cancelled"


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
        ],
        dialect="claude_stream_json",
    ),
    "codex": HarnessSpec(
        key="codex",
        display_name="Codex CLI",
        executable="codex",
        args=["proto"],
        dialect="codex_proto",
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
        args=[],
        dialect="raw_text",
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
        # Permission prompts surface here; the payload shape varies by CLI
        # version, so carry it verbatim alongside a normalised envelope rather
        # than guessing at fields that may not exist.
        req = obj.get("request") or {}
        out.append({
            "event": EVENT_APPROVAL_REQUEST,
            "command": req.get("command") or req.get("tool_name") or "",
            "description": req.get("description") or "",
            "choices": ["once", "always", "deny"],
            "request_id": obj.get("request_id"),
            "raw": req,
        })

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
    _approval_waiters: Dict[str, asyncio.Future] = field(default_factory=dict)

    # -- event fan-out -----------------------------------------------------

    def _emit(self, event: Dict[str, Any]) -> None:
        """Append to the durable log, then fan out to live subscribers.

        Log first: a subscriber that dies mid-write must not be able to lose
        an event for everyone else, and a client that reconnects reads the log,
        not the queue.
        """
        self.seq += 1
        event = dict(event)
        event["seq"] = self.seq
        event["session_id"] = self.session_id
        event["timestamp"] = time.time()

        # 0600 before the first write: the log carries raw CLI stdout/stderr,
        # which can contain tokens the CLI happened to print.
        if not self.log_path.exists():
            self.log_path.touch(mode=0o600)
        with self.log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")

        if event.get("event") == EVENT_APPROVAL_REQUEST:
            # Mint an id when the CLI gave none, so every request is
            # addressable even for dialects that omit request_id.
            approval_id = str(event.get("request_id") or f"ap_{uuid.uuid4().hex}")
            event["approval_id"] = approval_id
            self.pending_approvals[approval_id] = event
            self.status = "waiting_for_approval"
        elif event.get("event") == EVENT_APPROVAL_RESPONDED:
            answered = event.get("approval_id")
            if answered:
                self.pending_approvals.pop(answered, None)
            if not self.pending_approvals:
                self.status = "running"

        for queue in list(self._subscribers):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # A stalled subscriber is dropped rather than allowed to block
                # the session; it can catch up from the log by seq.
                self._subscribers.remove(queue)

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
            while True:
                event = await queue.get()
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

    async def start(self) -> None:
        env = dict(os.environ)
        env.setdefault("TERM", "dumb")
        args = [arg.replace("{cwd}", self.cwd) for arg in self.spec.args]
        self.process = await asyncio.create_subprocess_exec(
            self.spec.executable, *args,
            cwd=self.cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        self.status = "running"
        # Hold strong references: an un-referenced Task can be garbage
        # collected mid-flight, which would stop the reader silently.
        self._tasks = [
            asyncio.create_task(self._pump_stdout()),
            asyncio.create_task(self._pump_stderr()),
        ]

    async def _pump_stdout(self) -> None:
        assert self.process and self.process.stdout
        translate = TRANSLATORS.get(self.spec.dialect)
        while True:
            raw = await self.process.stdout.readline()
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
            self.process.stdin.write((text + "\n").encode("utf-8"))
            await self.process.stdin.drain()
            return
        self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()

    async def respond_to_approval(self, choice: str, approval_id: Optional[str] = None) -> None:
        """Answer one specific pending approval in the CLI's own dialect."""
        if approval_id:
            pending = self.pending_approvals.get(approval_id)
        elif len(self.pending_approvals) == 1:
            # Unambiguous: exactly one outstanding request.
            approval_id, pending = next(iter(self.pending_approvals.items()))
        else:
            pending = None
        if not pending or not self.process or not self.process.stdin:
            return
        request_id = pending.get("request_id")
        allowed = choice != "deny"

        if self.spec.dialect == "claude_stream_json":
            payload = {
                "type": "control_response",
                "request_id": request_id,
                "response": {"behavior": "allow" if allowed else "deny",
                             "updatedPermissions": [] if choice != "always" else [{"scope": "always"}]},
            }
        elif self.spec.dialect == "pi_rpc":
            payload = {"id": request_id, "type": "extension_ui_response",
                       "result": allowed if choice != "always" else "always"}
        elif self.spec.dialect == "codex_proto":
            decision = {"once": "approved", "always": "approved_for_session", "deny": "denied"}.get(choice, "denied")
            payload = {"id": str(uuid.uuid4()),
                       "op": {"type": "exec_approval", "id": request_id, "decision": decision}}
        else:
            return

        self.process.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        await self.process.stdin.drain()
        self._emit({"event": EVENT_APPROVAL_RESPONDED, "choice": choice, "approval_id": approval_id})

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

    def __init__(self, home: Optional[Path] = None):
        self.home = home or Path.home() / ".leoagent"
        self.sessions_dir = self.home / "harness-sessions"
        self.sessions_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            self.sessions_dir.chmod(0o700)   # tighten a pre-existing directory
        except OSError:
            pass
        self.sessions: Dict[str, HarnessSession] = {}

    async def create(self, harness: str, cwd: str, prompt: Optional[str] = None) -> HarnessSession:
        spec = HARNESSES.get(harness)
        if spec is None:
            raise ValueError(f"unknown harness: {harness}")
        if not spec.is_available():
            raise RuntimeError(f"{spec.display_name} is not installed on this machine")
        work_dir = os.path.expanduser(cwd)
        if not os.path.isdir(work_dir):
            raise ValueError(f"not a directory: {cwd}")

        session_id = f"hs_{uuid.uuid4().hex}"
        session = HarnessSession(
            session_id=session_id,
            spec=spec,
            cwd=work_dir,
            log_path=self.sessions_dir / f"{session_id}.ndjson",
        )
        self.sessions[session_id] = session
        await session.start()
        if prompt:
            await session.send(prompt)
        return session

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
