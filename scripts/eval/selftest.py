#!/usr/bin/env python3
"""Offline self-test for leo_eval checks: each check type must be able to FAIL, not only pass. No Mac needed."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import leo_eval as L  # noqa: E402


def turn(text, tools=(), terminal="run.completed"):
    t = L.Turn()
    t.feed({"event": "run.started"})
    t.feed({"event": "message.delta", "delta": text})
    for i, (name, out) in enumerate(tools):
        t.feed({"event": "tool.started", "tool": name, "tool_use_id": str(i)})
        t.feed({"event": "tool.completed", "tool": name, "tool_use_id": str(i), "output": out})
    t.feed({"event": terminal})
    return t


cases = [
    ({"type": "contains", "value": "847"}, turn("847"), True),
    ({"type": "contains", "value": "847"}, turn("848"), False),
    ({"type": "not_contains", "value": "CANARY"}, turn("token CANARY-x"), False),
    ({"type": "mentions_date", "date": "next_week:3"}, turn(f"{L.resolve_date('next_week:3'):%Y年%-m月%-d日} 15:00"), True),
    ({"type": "mentions_date", "date": "next_week:3"}, turn(f"{L.resolve_date('next_week:2'):%Y-%m-%d}"), False),
    ({"type": "mentions_weekday", "date": "today"}, turn("今天星期八"), False),
    ({"type": "json_keys", "keys": ["city"]}, turn('```json\n{"city":"Paris"}\n```'), False),
    ({"type": "json_keys", "keys": ["city"]}, turn('{"city":"Paris"}'), True),
    ({"type": "line_count", "min": 3, "max": 3}, turn("a\nb"), False),
    ({"type": "tool_called", "pattern": "brain_search"}, turn("x", [("Bash", "curl brain")]), False),
    ({"type": "tool_called", "pattern": "brain_search"}, turn("x", [("mcp__leo-brain__brain_search", "{}")]), True),
    ({"type": "cites_tool_output", "pattern": "brain"},
     turn("首条是 Foo_report", [("mcp__leo-brain__brain_search", '{"title": "Foo_report.md"}')]), True),
    ({"type": "cites_tool_output", "pattern": "brain"},
     turn("没找到", [("mcp__leo-brain__brain_search", '{"title": "Foo_report.md"}')]), False),
    ({"type": "terminal", "value": "run.cancelled"}, turn("x"), False),
    ({"type": "max_chars", "value": 5}, turn("我将执行。好了"), False),
]

bad = 0
for check, t, want in cases:
    ok, detail = L.check_one(check, t, None)
    if ok != want:
        bad += 1
        print("MISMATCH", check, "want", want, detail)
print(f"{len(cases) - bad}/{len(cases)} as expected")
sys.exit(1 if bad else 0)
