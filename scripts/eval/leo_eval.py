#!/usr/bin/env python3
"""LeoBot agent regression eval, driven end-to-end through Leo Link (the phone protocol) via the relay.

Stdlib only. See scripts/eval/README.md for usage, task format, cost and safety notes.

Protocol facts this relies on (src/mac/leophone/packages/desktop/src/host/leo/link/bridge.ts):
  POST /harness/sessions {prompt, cwd, harness, mode}         -> 202 {session_id, ...}
  GET  /harness/sessions/<id>/events?after=N                  -> SSE only ("data: {...}"), first frame {type:resume}
  POST /harness/sessions/<id>/send {text} | /stop | /archive | /approval {approval_id, choice}
  GET  /harness/sessions/<id>/changes, /diff?path=            -> git-based workspace view (agent-independent)
  GET/DELETE /automations[/<id>]
Every POST carries X-Leo-Request-Id (operation receipts dedupe on it).
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import socket
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid

RELAY = "https://relay.leoyuan.top/relay/api/m/"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) LeoBotEval/1.0"
RUN_END = {"run.completed", "run.failed", "run.cancelled"}
TEXT_LIMIT = 4000
WEEKDAYS_ZH = "一二三四五六日"


# --------------------------------------------------------------------------- Leo Link client


class Link:
    def __init__(self, target: str, key: str, relay: str = RELAY):
        self.base = relay.rstrip("/") + "/" + urllib.parse.quote(target)
        self._key = key

    def _headers(self, extra: dict | None = None) -> dict:
        h = {"Authorization": f"Bearer {self._key}", "User-Agent": UA, "Accept": "application/json"}
        h.update(extra or {})
        return h

    def call(self, method: str, path: str, body=None, timeout: float = 90) -> tuple[int, object]:
        headers = self._headers()
        data = None
        if method in ("POST", "PUT", "PATCH", "DELETE"):
            headers["X-Leo-Request-Id"] = str(uuid.uuid4())
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        elif method in ("POST", "PUT", "PATCH"):
            data = b"{}"
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                status = resp.status
        except urllib.error.HTTPError as e:
            raw, status = e.read(), e.code
        except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as e:
            return 0, {"error": {"message": f"{type(e).__name__}: {e}"}}
        try:
            return status, json.loads(raw.decode() or "null")
        except ValueError:
            return status, {"raw": raw[:500].decode(errors="replace")}

    def stream(self, sid: str, after: int, on_event, deadline: float, read_timeout: float = 25) -> str:
        """Feed events with seq > after to on_event until it returns True ("done") or the deadline passes ("timeout").

        Reconnects with ?after=<last seq> on read timeouts / drops (the Mac journal replays the gap)."""
        last = after
        while time.time() < deadline:
            url = f"{self.base}/harness/sessions/{urllib.parse.quote(sid)}/events?after={last}"
            req = urllib.request.Request(url, headers=self._headers({"Accept": "text/event-stream"}))
            try:
                with urllib.request.urlopen(req, timeout=min(read_timeout, max(1.0, deadline - time.time()))) as resp:
                    for raw in resp:
                        if time.time() >= deadline:
                            return "timeout"
                        line = raw.decode(errors="replace").strip()
                        if not line.startswith("data:"):
                            continue
                        try:
                            ev = json.loads(line[5:].strip())
                        except ValueError:
                            continue
                        if not isinstance(ev, dict) or ev.get("type") == "resume":
                            continue
                        seq = ev.get("seq")
                        if isinstance(seq, int):
                            if seq <= last:
                                continue
                            last = seq
                        if on_event(ev):
                            return "done"
            except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError, OSError):
                pass
            time.sleep(0.5)
        return "timeout"


# --------------------------------------------------------------------------- template / date helpers


def local_today() -> dt.date:
    return dt.datetime.now().astimezone().date()


def resolve_date(expr: str) -> dt.date:
    """today | today+N | today-N | next_week:<1..7> (Mon..Sun of next calendar week) | this_week:<1..7>"""
    today = local_today()
    m = re.fullmatch(r"today([+-]\d+)?", expr)
    if m:
        return today + dt.timedelta(days=int(m.group(1) or 0))
    m = re.fullmatch(r"(next|this)_week:([1-7])", expr)
    if m:
        monday = today - dt.timedelta(days=today.weekday())
        if m.group(1) == "next":
            monday += dt.timedelta(days=7)
        return monday + dt.timedelta(days=int(m.group(2)) - 1)
    raise ValueError(f"bad date expr {expr!r}")


def date_patterns(d: dt.date) -> list[str]:
    y, mo, da = d.year, d.month, d.day
    return [
        rf"{y}\s*-\s*0?{mo}\s*-\s*0?{da}(?!\d)",
        rf"{y}\s*/\s*0?{mo}\s*/\s*0?{da}(?!\d)",
        rf"{y}\s*\.\s*0?{mo}\s*\.\s*0?{da}(?!\d)",
        rf"(?<!\d)0?{mo}\s*月\s*0?{da}\s*[日号]",
    ]


def render(value, ctx: dict):
    if isinstance(value, str):
        def sub(m):
            k = m.group(1)
            if k.startswith("date:"):
                return resolve_date(k[5:]).isoformat()
            return str(ctx.get(k, m.group(0)))
        return re.sub(r"\{\{([a-zA-Z0-9_:+\-]+)\}\}", sub, value)
    if isinstance(value, list):
        return [render(v, ctx) for v in value]
    if isinstance(value, dict):
        return {k: render(v, ctx) for k, v in value.items()}
    return value


# --------------------------------------------------------------------------- turn recording


class Turn:
    def __init__(self):
        self.t0 = time.time()
        self.first_event_s = None
        self.first_text_s = None
        self.total_s = None
        self.text_parts: list[str] = []
        self.tools: list[dict] = []
        self._open_tools: dict = {}
        self.terminal = None
        self.error = None
        self.approvals: list[dict] = []
        self.notes: list[str] = []
        self.events = 0
        self.raw: list[dict] = []

    @property
    def text(self) -> str:
        return "".join(self.text_parts)

    def feed(self, ev: dict) -> None:
        self.raw.append(ev)
        name = ev.get("event")
        self.events += 1
        el = time.time() - self.t0
        if name in ("message.delta", "tool.started", "reasoning.available", "run.started") and self.first_event_s is None:
            self.first_event_s = round(el, 2)
        if name == "message.delta":
            if self.first_text_s is None:
                self.first_text_s = round(el, 2)
            self.text_parts.append(str(ev.get("delta", "")))
        elif name == "tool.started":
            t = {"tool": ev.get("tool"), "id": ev.get("tool_use_id"), "preview": ev.get("preview", ""),
                 "input": ev.get("input"), "output": "", "error": None}
            self.tools.append(t)
            self._open_tools[ev.get("tool_use_id")] = t
        elif name == "tool.completed":
            t = self._open_tools.pop(ev.get("tool_use_id"), None)
            if t is None:
                t = {"tool": ev.get("tool"), "id": ev.get("tool_use_id"), "preview": "", "input": None}
                self.tools.append(t)
            t["output"] = str(ev.get("output", ""))
            t["error"] = bool(ev.get("error"))
            t["duration"] = ev.get("duration")
        elif name == "approval.request":
            self.approvals.append({k: ev.get(k) for k in ("approval_id", "tool", "command")})
        elif name == "session.note":
            self.notes.append(str(ev.get("text", ""))[:300])
        elif name in RUN_END:
            self.terminal = name
            self.error = ev.get("error")
            self.total_s = round(el, 2)

    def tool_haystack(self, t: dict, with_output: bool = False) -> str:
        parts = [str(t.get("tool") or ""), str(t.get("preview") or ""), json.dumps(t.get("input"), ensure_ascii=False)]
        if with_output:
            parts.append(str(t.get("output") or ""))
        return "\n".join(parts)

    def summary(self) -> dict:
        return {
            "terminal": self.terminal,
            "error": self.error,
            "first_event_s": self.first_event_s,
            "first_text_s": self.first_text_s,
            "total_s": self.total_s if self.total_s is not None else round(time.time() - self.t0, 2),
            "tools": [{"tool": t.get("tool"), "preview": str(t.get("preview") or "")[:160],
                       "error": t.get("error")} for t in self.tools],
            "approvals": self.approvals,
            "notes": self.notes,
            "text": self.text[:TEXT_LIMIT],
        }


# --------------------------------------------------------------------------- checks


class Ctx:
    """Per-run context handed to checks: link, session, workspace paths, template vars."""

    def __init__(self, link: Link, sid: str, rel_dir: str, vars_: dict):
        self.link, self.sid, self.rel_dir, self.vars = link, sid, rel_dir, vars_


def _norm(s: str, ci: bool) -> str:
    return s.lower() if ci else s


def _changes(ctx: Ctx) -> dict:
    status, body = ctx.link.call("GET", f"/harness/sessions/{ctx.sid}/changes")
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError(f"/changes -> {status} {body}")
    return body


def check_one(c: dict, turn: Turn, ctx: Ctx) -> tuple[bool, str]:
    kind = c["type"]
    text = turn.text
    ci = c.get("ci", True)
    if kind in ("contains", "not_contains"):
        values = c.get("any") or [c["value"]]
        hit = [v for v in values if _norm(v, ci) in _norm(text, ci)]
        ok = bool(hit) if kind == "contains" else not hit
        return ok, f"hit={hit}" if hit else "no hit"
    if kind in ("regex", "not_regex"):
        flags = re.S | (re.I if ci else 0)
        m = re.search(c["pattern"], text, flags)
        return (bool(m) if kind == "regex" else not m), (f"match={m.group(0)[:80]!r}" if m else "no match")
    if kind == "mentions_date":
        d = resolve_date(c["date"])
        ok = any(re.search(p, text) for p in date_patterns(d))
        return ok, f"want {d.isoformat()}"
    if kind == "mentions_weekday":
        d = resolve_date(c["date"])
        w = WEEKDAYS_ZH[d.weekday()]
        alts = f"[{w}天]" if w == "日" else w
        en = d.strftime("%A")
        ok = bool(re.search(rf"(星期|周|礼拜){alts}|{en}", text, re.I))
        return ok, f"want 周{w}/{en}"
    if kind == "json_keys":
        body = text.strip()
        if c.get("allow_fence", False):
            body = re.sub(r"^```(?:json)?\s*|\s*```$", "", body)
        try:
            obj = json.loads(body)
        except ValueError as e:
            return False, f"not json: {e}"
        missing = [k for k in c["keys"] if not (isinstance(obj, dict) and k in obj)]
        if missing:
            return False, f"missing {missing}"
        for k, v in (c.get("equals") or {}).items():
            if obj.get(k) != v:
                return False, f"{k}={obj.get(k)!r} != {v!r}"
        return True, "ok"
    if kind == "line_count":
        lines = [ln for ln in text.strip().splitlines() if ln.strip()]
        ok = c.get("min", 0) <= len(lines) <= c.get("max", 10**9)
        return ok, f"{len(lines)} lines"
    if kind == "max_chars":
        return len(text.strip()) <= c["value"], f"{len(text.strip())} chars"
    if kind in ("tool_called", "tool_not_called"):
        pat = re.compile(c["pattern"], re.I | re.S)
        hits = [t for t in turn.tools if pat.search(turn.tool_haystack(t, c.get("in_output", False)))]
        n = len(hits)
        if kind == "tool_called":
            return n >= c.get("min", 1), f"{n} matching of {len(turn.tools)}"
        return n == 0, f"{n} matching: {[h.get('preview') for h in hits][:3]}"
    if kind == "cites_tool_output":
        # Some title/path-like string from the matching tool's output must appear in the reply.
        pat = re.compile(c["pattern"], re.I)
        outs = [t.get("output") or "" for t in turn.tools if pat.search(str(t.get("tool") or ""))]
        cands = set()
        for out in outs:
            for key in c.get("keys", ["title", "path", "name"]):
                for m in re.finditer(rf'"{key}"\s*:\s*"([^"]{{4,120}})"', out):
                    cands.add(m.group(1))
                for m in re.finditer(rf"(?m)^\s*{key}\s*[:：]\s*(.{{4,120}})$", out):
                    cands.add(m.group(1).strip())
        stems = set()
        for s in cands:
            stems.add(s)
            base = os.path.splitext(os.path.basename(s))[0]
            if len(base) >= 4:
                stems.add(base)
        hit = [s for s in stems if s.lower() in text.lower()]
        return bool(hit), f"{len(outs)} outputs, {len(stems)} candidates, hit={hit[:2]}"
    if kind == "terminal":
        return turn.terminal == c["value"], f"terminal={turn.terminal}"
    if kind == "max_seconds":
        tot = turn.total_s if turn.total_s is not None else time.time() - turn.t0
        return tot <= c["value"], f"{tot:.1f}s"
    if kind == "file_exists":
        rel = f"{ctx.rel_dir}/{c['path']}"
        body = _changes(ctx)
        if not body.get("is_repo"):
            return False, "workspace is not a git repo (setup failed?)"
        paths = {f.get("path"): f for f in body.get("files", [])}
        want = c.get("exists", True)
        present = rel in paths and paths[rel].get("status") != "D"
        if present != want:
            return False, f"{rel} present={present}"
        if want and "contains" in c:
            st, d = ctx.link.call("GET", f"/harness/sessions/{ctx.sid}/diff?path={urllib.parse.quote(rel)}")
            diff = d.get("diff", "") if isinstance(d, dict) else ""
            added = "\n".join(ln[1:] for ln in diff.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
            ok = c["contains"] in added and not (c.get("absent") and c["absent"] in added)
            return ok, f"content has {c['contains']!r}: {c['contains'] in added}" + (
                f", absent {c['absent']!r}: {c['absent'] not in added}" if c.get("absent") else "")
        return True, f"{rel} present={present}"
    if kind == "automation_count":
        st, body = ctx.link.call("GET", "/automations")
        if st != 200:
            return False, f"/automations -> {st}"
        pat = re.compile(c["match"], re.I)
        items = [a for a in body.get("automations", []) if pat.search(f"{a.get('name')}\n{a.get('prompt')}")]
        n = len(items)
        ops = {">=": n >= c["value"], "==": n == c["value"], "<=": n <= c["value"]}
        ok = ops[c.get("op", ">=")]
        if ok and items and c.get("cron"):
            crons = [((a.get("schedule") or {}).get("cron")) for a in items]
            ok = c["cron"] in crons
            return ok, f"{n} matching, crons={crons}"
        return ok, f"{n} matching"
    raise ValueError(f"unknown check type {kind}")


def run_checks(checks: list, turn: Turn, ctx: Ctx) -> list[dict]:
    out = []
    for c in checks:
        c = render(c, ctx.vars)
        try:
            ok, detail = check_one(c, turn, ctx)
        except Exception as e:  # noqa: BLE001 - a broken check is a failed check, recorded
            ok, detail = False, f"check error: {type(e).__name__}: {e}"
        out.append({"type": c["type"], "ok": bool(ok), "detail": detail, **({"label": c["label"]} if "label" in c else {})})
    return out


# --------------------------------------------------------------------------- task runner


def drive_turn(link: Link, sid: str, after: int, deadline: float, step: dict, task: dict, turn: Turn,
               log) -> int:
    """Stream one turn to its terminal event. Handles approvals (deny/allow per task) and stop-on-tool."""
    state = {"last": after, "stopped": False, "seen_user": False}
    stop_pat = re.compile(step["stop_on_tool"], re.I) if step.get("stop_on_tool") else None
    on_approval = task.get("on_approval", "deny")

    def on_event(ev):
        if isinstance(ev.get("seq"), int):
            state["last"] = ev["seq"]
        name = ev.get("event")
        if name == "user.message":
            state["seen_user"] = True
            return False
        turn.feed(ev)
        if name == "approval.request":
            choice = "deny" if on_approval == "deny" else "once"
            st, _ = link.call("POST", f"/harness/sessions/{sid}/approval",
                              {"approval_id": ev.get("approval_id"), "choice": choice})
            log(f"    approval {ev.get('tool')} -> {choice} ({st})")
        if stop_pat and not state["stopped"] and name == "tool.started" and stop_pat.search(
                f"{ev.get('tool')} {ev.get('preview')} {json.dumps(ev.get('input'), ensure_ascii=False)}"):
            time.sleep(step.get("stop_delay", 2))
            st, body = link.call("POST", f"/harness/sessions/{sid}/stop")
            state["stopped"] = True
            turn.stop_sent_s = round(time.time() - turn.t0, 2)
            log(f"    stop sent at {turn.stop_sent_s}s -> {st}")
        return name in RUN_END

    res = link.stream(sid, after, on_event, deadline)
    if res == "timeout" and turn.terminal is None:
        turn.terminal = "timeout"
        if stop_pat and not state["stopped"]:
            pass
    return state["last"]


def run_task_once(link: Link, task: dict, run_no: int, run_id: str, workspace_root: str, log,
                  raw_dir: str | None = None) -> dict:
    tid = task["id"]
    rel_dir = f"{tid}-r{run_no}"
    cwd = f"{workspace_root}/{rel_dir}"
    vars_ = {"cwd": cwd, "run_id": run_id, "marker": f"EVAL{run_id[-6:]}{run_no}", "rel_dir": rel_dir,
             "today": local_today().isoformat()}
    vars_.update(task.get("vars", {}))
    vars_ = {k: render(v, vars_) for k, v in vars_.items()}
    timeout = task.get("timeout", 180)
    record = {"task": tid, "category": task["category"], "run": run_no, "run_id": run_id, "cwd": cwd,
              "started_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
              "steps": [], "pass": False, "error": None, "session_id": None}
    sid = None
    try:
        last = 0
        for i, step in enumerate(task["steps"]):
            step = dict(step)
            prompt = render(step["prompt"], vars_)
            turn = Turn()
            deadline = time.time() + step.get("timeout", timeout)
            if i == 0:
                body = {"prompt": prompt, "cwd": cwd, "harness": task.get("harness", "zcode"),
                        "mode": task.get("mode", "yolo")}
                st, resp = link.call("POST", "/harness/sessions", body)
                if st not in (200, 201, 202) or not isinstance(resp, dict) or not resp.get("session_id"):
                    raise RuntimeError(f"create session -> {st} {json.dumps(resp, ensure_ascii=False)[:300]}")
                sid = resp["session_id"]
                record["session_id"] = sid
                log(f"  [{tid} r{run_no}] session {sid}")
            else:
                st, resp = link.call("POST", f"/harness/sessions/{sid}/send", {"text": prompt})
                if st not in (200, 202):
                    raise RuntimeError(f"send -> {st} {json.dumps(resp, ensure_ascii=False)[:300]}")
            last = drive_turn(link, sid, last, deadline, step, task, turn, log)
            ctx = Ctx(link, sid, rel_dir, vars_)
            checks = list(step.get("checks", []))
            if step.get("expect_terminal", "run.completed") and not any(c["type"] == "terminal" for c in checks):
                checks.insert(0, {"type": "terminal", "value": step.get("expect_terminal", "run.completed")})
            results = run_checks(checks, turn, ctx)
            srec = {"prompt": prompt[:300], **turn.summary(), "checks": results}
            if hasattr(turn, "stop_sent_s"):
                srec["stop_sent_s"] = turn.stop_sent_s
            record["steps"].append(srec)
            if raw_dir:
                with open(os.path.join(raw_dir, f"{tid}-r{run_no}.jsonl"), "a") as rf:
                    for ev in turn.raw:
                        rf.write(json.dumps(ev, ensure_ascii=False) + "\n")
            if turn.terminal == "timeout":
                # Don't leave a runaway turn on the Mac.
                link.call("POST", f"/harness/sessions/{sid}/stop")
                break
        record["pass"] = bool(record["steps"]) and len(record["steps"]) == len(task["steps"]) and all(
            c["ok"] for s in record["steps"] for c in s["checks"])
    except Exception as e:  # noqa: BLE001
        record["error"] = f"{type(e).__name__}: {e}"
        log("    harness error: " + record["error"])
        if os.environ.get("LEO_EVAL_DEBUG"):
            traceback.print_exc()
    finally:
        record["cleanup"] = cleanup(link, task, sid, vars_, log)
    first = record["steps"][0] if record["steps"] else {}
    record["first_event_s"] = first.get("first_event_s")
    record["total_s"] = round(sum(s.get("total_s") or 0 for s in record["steps"]), 2)
    return record


def cleanup(link: Link, task: dict, sid: str | None, vars_: dict, log) -> list:
    done = []
    for action in render(task.get("cleanup", []), vars_):
        try:
            if action["type"] == "delete_automations":
                st, body = link.call("GET", "/automations")
                pat = re.compile(action["match"], re.I)
                for a in (body.get("automations", []) if st == 200 else []):
                    if pat.search(f"{a.get('name')}\n{a.get('prompt')}"):
                        dst, _ = link.call("DELETE", f"/automations/{a['id']}")
                        done.append(f"deleted automation {a['id']} ({dst})")
        except Exception as e:  # noqa: BLE001
            done.append(f"cleanup error {action}: {e}")
    if sid:
        done.append(f"archive {archive_session(link, sid)}")
    for d in done:
        log("    cleanup: " + d)
    return done


def archive_session(link: Link, sid: str) -> int:
    """Archive; a still-running session (409) is stopped first and retried for up to ~40 s."""
    st, _ = link.call("POST", f"/harness/sessions/{sid}/archive")
    if st == 409:
        link.call("POST", f"/harness/sessions/{sid}/stop")
        for _ in range(20):
            time.sleep(2)
            st, _ = link.call("POST", f"/harness/sessions/{sid}/archive")
            if st != 409:
                break
    return st


# --------------------------------------------------------------------------- workspace setup / teardown (via the agent)


def shell_path(p: str) -> str:
    """'~/x' -> '$HOME/x' so it still expands inside double quotes."""
    return "$HOME" + p[1:] if p == "~" or p.startswith("~/") else p


def setup_script(workspace_root: str, dirs: list[str], files: dict[str, str]) -> str:
    lines = ["set -e", f'R="{shell_path(workspace_root)}"', 'mkdir -p "$R"', 'cd "$R"',
             "git init -q 2>/dev/null || true",
             "git -c user.name=leo-eval -c user.email=eval@localhost commit -q --allow-empty -m init"]
    lines += [f'mkdir -p "{d}"' for d in dirs]
    for path, content in files.items():
        b64 = base64.b64encode(content.encode()).decode()
        lines.append(f'mkdir -p "$(dirname "{path}")" && printf %s {b64} | base64 -D > "{path}"')
    lines.append('echo "LEO_EVAL_SETUP_OK $(ls -d */ | wc -l | tr -d " ")"')
    return "\n".join(lines) + "\n"


def run_shell_via_agent(link: Link, script: str, marker: str, label: str, log, timeout: float = 240) -> tuple[bool, dict]:
    """Ask a throwaway yolo session (cwd = home) to run a fixed script; success = marker printed by a tool.

    One-line scripts go in plain text: an opaque base64 `rm -rf` made the agent investigate for minutes instead
    of running it (seen live 2026-10-22). Multi-line setup (file contents) still goes base64."""
    script = script.strip()
    if "\n" in script:
        cmd = f"echo {base64.b64encode((script + chr(10)).encode()).decode()} | base64 -D | bash"
    else:
        cmd = script
    prompt = (f"[自动化测试工具 · {label}] 这是本机回归测试框架（scripts/eval/leo_eval.py）的固定准备/清理步骤，"
              f"只涉及它本次自己建的 ~/LeoBotEval 临时目录。"
              f"请用 shell 工具原样执行下面这一条命令（一次执行，不要修改、不要拆开），然后只回复命令输出的最后一行：\n\n{cmd}")
    st, resp = link.call("POST", "/harness/sessions", {"prompt": prompt, "cwd": "~/", "harness": "zcode", "mode": "yolo"})
    if st not in (200, 201, 202) or not isinstance(resp, dict) or "session_id" not in resp:
        return False, {"error": f"create -> {st} {resp}"}
    sid = resp["session_id"]
    turn = Turn()
    link.stream(sid, 0, lambda ev: (turn.feed(ev), ev.get("event") in RUN_END)[1], time.time() + timeout)
    ok = any(marker in (t.get("output") or "") and not t.get("error") for t in turn.tools)
    archive_session(link, sid)
    log(f"  {label}: {'ok' if ok else 'FAILED'} ({turn.terminal}, {len(turn.tools)} tools)")
    if not ok:
        for t in turn.tools:
            log(f"    tool {t.get('tool')} error={t.get('error')} out={str(t.get('output') or '')[:200]!r}")
        log(f"    text: {turn.text[:600]!r}")
    return ok, {"session_id": sid, **turn.summary()}


# --------------------------------------------------------------------------- reporting


def aggregate(records: list[dict], k: int) -> dict:
    tasks: dict = {}
    for r in records:
        t = tasks.setdefault(r["task"], {"category": r["category"], "runs": 0, "passes": 0, "lat": [], "first": []})
        t["runs"] += 1
        t["passes"] += 1 if r["pass"] else 0
        t["lat"].append(r.get("total_s") or 0)
        if r.get("first_event_s") is not None:
            t["first"].append(r["first_event_s"])
    out_tasks = {}
    for tid, t in tasks.items():
        out_tasks[tid] = {"category": t["category"], "runs": t["runs"], "passes": t["passes"],
                          "pass_at_1": round(t["passes"] / t["runs"], 3) if t["runs"] else 0,
                          "pass_hat_k": t["runs"] >= k and t["passes"] == t["runs"],
                          "median_total_s": sorted(t["lat"])[len(t["lat"]) // 2] if t["lat"] else None,
                          "median_first_event_s": sorted(t["first"])[len(t["first"]) // 2] if t["first"] else None}
    cats: dict = {}
    for tid, t in out_tasks.items():
        c = cats.setdefault(t["category"], {"tasks": 0, "runs": 0, "passes": 0, "pass_hat_k": 0})
        c["tasks"] += 1
        c["runs"] += t["runs"]
        c["passes"] += t["passes"]
        c["pass_hat_k"] += 1 if t["pass_hat_k"] else 0
    for c in cats.values():
        c["pass_at_1"] = round(c["passes"] / c["runs"], 3) if c["runs"] else 0
    total_runs = sum(t["runs"] for t in out_tasks.values())
    return {"k": k, "tasks": out_tasks, "categories": cats,
            "overall": {"tasks": len(out_tasks), "runs": total_runs,
                        "pass_at_1": round(sum(t["passes"] for t in out_tasks.values()) / total_runs, 3) if total_runs else 0,
                        "pass_hat_k": sum(1 for t in out_tasks.values() if t["pass_hat_k"])}}


def compare(summary: dict, baseline: dict) -> list[str]:
    flags = []
    for tid, t in summary["tasks"].items():
        b = baseline.get("tasks", {}).get(tid)
        if not b:
            continue
        if b.get("pass_hat_k") and not t["pass_hat_k"]:
            flags.append(f"REGRESSION {tid}: pass^k true -> false (pass@1 {b['pass_at_1']} -> {t['pass_at_1']})")
        elif t["pass_at_1"] + 1e-9 < b.get("pass_at_1", 0):
            flags.append(f"regression {tid}: pass@1 {b['pass_at_1']} -> {t['pass_at_1']}")
        elif t["pass_at_1"] > b.get("pass_at_1", 0) + 1e-9:
            flags.append(f"improved {tid}: pass@1 {b['pass_at_1']} -> {t['pass_at_1']}")
        bl, tl = b.get("median_total_s"), t.get("median_total_s")
        if bl and tl and tl > bl * 1.5 and tl - bl > 10:
            flags.append(f"slower {tid}: median {bl}s -> {tl}s")
    return flags


def markdown(summary: dict, records: list[dict], meta: dict, flags: list[str]) -> str:
    k = summary["k"]
    o = summary["overall"]
    lines = [f"# LeoBot eval {meta['run_id']}", "",
             f"- target: `{meta['target']}`  k={k}  started {meta['started']}  wall {meta['wall_s']}s",
             f"- overall: pass@1 **{o['pass_at_1']}** over {o['runs']} runs; pass^{k} {o['pass_hat_k']}/{o['tasks']} tasks", ""]
    if flags:
        lines += ["## Baseline comparison", ""] + [f"- {f}" for f in flags] + [""]
    lines += ["## By category", "", f"| category | tasks | pass@1 | pass^{k} |", "|---|---|---|---|"]
    for name, c in sorted(summary["categories"].items()):
        lines.append(f"| {name} | {c['tasks']} | {c['pass_at_1']} | {c['pass_hat_k']}/{c['tasks']} |")
    lines += ["", "## By task", "", f"| task | category | pass@1 | pass^{k} | median total s | median first event s | failed checks (last failing run) |",
              "|---|---|---|---|---|---|---|"]
    last_fail = {}
    for r in records:
        if not r["pass"]:
            bad = [f"{c['type']}: {c['detail']}" for s in r["steps"] for c in s["checks"] if not c["ok"]]
            if r.get("error"):
                bad.insert(0, "harness: " + r["error"])
            last_fail[r["task"]] = "; ".join(bad)[:220].replace("|", "/").replace("\n", " ")
    for tid, t in summary["tasks"].items():
        lines.append(f"| {tid} | {t['category']} | {t['pass_at_1']} | {'yes' if t['pass_hat_k'] else 'no'} | "
                     f"{t['median_total_s']} | {t['median_first_event_s']} | {last_fail.get(tid, '')} |")
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- main


def main(argv=None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description="LeoBot agent regression eval over Leo Link")
    ap.add_argument("--target", default="LeoMac-Studio-2")
    ap.add_argument("--tasks", default=os.path.join(here, "tasks.json"))
    ap.add_argument("--k", type=int, default=3)
    ap.add_argument("--only", default="", help="comma-separated task ids or category:<name>")
    ap.add_argument("--out", default="")
    ap.add_argument("--baseline", default="", help="previous summary.json to compare against")
    ap.add_argument("--key-file", default=os.path.expanduser("~/.leoagent/key"))
    ap.add_argument("--relay", default=RELAY)
    ap.add_argument("--keep-workspace", action="store_true", help="skip removing ~/LeoBotEval/<run> on the target")
    args = ap.parse_args(argv)

    with open(args.key_file) as f:
        key = f.read().strip()
    link = Link(args.target, key, args.relay)
    with open(args.tasks) as f:
        spec = json.load(f)
    tasks = spec["tasks"]
    if args.only:
        wanted = [w.strip() for w in args.only.split(",") if w.strip()]
        tasks = [t for t in tasks if t["id"] in wanted or f"category:{t['category']}" in wanted]
        if not tasks:
            print("no tasks selected", file=sys.stderr)
            return 2

    run_id = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = args.out or os.path.join(here, "runs", run_id)
    os.makedirs(out, exist_ok=True)
    jsonl_path = os.path.join(out, "runs.jsonl")
    raw_dir = os.path.join(out, "raw")
    os.makedirs(raw_dir, exist_ok=True)
    logf = open(os.path.join(out, "log.txt"), "a")

    def log(msg):
        print(msg, flush=True)
        logf.write(msg + "\n")
        logf.flush()

    st, caps = link.call("GET", "/v1/capabilities", timeout=30)
    if st != 200:
        log(f"target {args.target} unreachable: {st} {caps}")
        return 3
    log(f"target {args.target} app {caps.get('app_version')} — {len(tasks)} tasks × k={args.k}, out={out}")
    workspace_root = f"~/LeoBotEval/{run_id}"
    dirs = [f"{t['id']}-r{n}" for t in tasks for n in range(1, args.k + 1)]
    files = {}
    for t in tasks:
        for n in range(1, args.k + 1):
            v = {"marker": f"EVAL{run_id[-6:]}{n}", "run_id": run_id}
            for rel, content in (t.get("setup_files") or {}).items():
                files[f"{t['id']}-r{n}/{rel}"] = render(content, v)
    started = time.time()
    ok, setup_rec = run_shell_via_agent(link, setup_script(workspace_root, dirs, files), "LEO_EVAL_SETUP_OK",
                                        "setup workspace", log)
    meta = {"run_id": run_id, "target": args.target, "app_version": caps.get("app_version"),
            "started": dt.datetime.now().astimezone().isoformat(timespec="seconds"), "workspace": workspace_root,
            "setup_ok": ok}
    if not ok:
        log("workspace setup failed; aborting (see log). Setup turn: " + json.dumps(setup_rec, ensure_ascii=False)[:800])
        return 4

    records = []
    try:
        with open(jsonl_path, "a") as jf:
            for t in tasks:
                for n in range(1, args.k + 1):
                    log(f"- {t['id']} ({t['category']}) run {n}/{args.k}")
                    rec = run_task_once(link, t, n, run_id, workspace_root, log, raw_dir)
                    records.append(rec)
                    jf.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    jf.flush()
                    fails = [f"{c['type']}({c['detail']})" for s in rec["steps"] for c in s["checks"] if not c["ok"]]
                    log(f"  => {'PASS' if rec['pass'] else 'FAIL'} {rec.get('total_s')}s "
                        f"{('err=' + rec['error']) if rec.get('error') else ''} {'; '.join(fails)[:300]}")
    except KeyboardInterrupt:
        log("interrupted — writing partial summary and cleaning up")
    finally:
        if not args.keep_workspace:
            run_shell_via_agent(link, f'rm -rf "{shell_path(workspace_root)}" && echo LEO_EVAL_CLEAN_OK\n', "LEO_EVAL_CLEAN_OK",
                                "remove workspace", log)

    meta["wall_s"] = round(time.time() - started, 1)
    summary = aggregate(records, args.k)
    summary["meta"] = meta
    flags = []
    if args.baseline:
        with open(args.baseline) as f:
            flags = compare(summary, json.load(f))
        summary["baseline_flags"] = flags
    with open(os.path.join(out, "summary.json"), "w") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    md = markdown(summary, records, meta, flags)
    with open(os.path.join(out, "summary.md"), "w") as f:
        f.write(md)
    log("\n" + md)
    return 0 if not any(f.startswith("REGRESSION") for f in flags) else 1


if __name__ == "__main__":
    sys.exit(main())
