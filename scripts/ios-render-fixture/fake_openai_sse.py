#!/usr/bin/env python3
"""Fake OpenAI-compatible chat endpoint that streams a fixed markdown answer.

Dev-only render harness for the iOS chat renderer: point a DEBUG build's provider
at http://127.0.0.1:<port>/v1 (via the debug server's provider.instances.create)
and every streaming request gets `fixture.md` back in realistic chunks, through
the app's real SSE -> throttle -> parse -> render path.

  python3 fake_openai_sse.py --port 8799 --delay 0.035 [--fixture fixture.md]

The delay file (`--delay-file`, re-read per request) lets a harness slow a single
reply down for mid-stream screenshots without restarting the server.
"""
from __future__ import annotations
import argparse
import json
import random
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent


def chunks(text: str, rng: random.Random):
    i = 0
    while i < len(text):
        n = rng.randint(2, 14)  # token-ish: a few CJK chars or a short English run
        yield text[i:i + n]
        i += n


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    fixture = ""
    reasoning = ""
    delay = 0.035
    delay_file: Path | None = None

    def log_message(self, fmt, *args):
        pass

    def _json(self, code: int, obj) -> None:
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._json(200, {"object": "list", "data": [{"id": "fixture-model", "object": "model"}]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            req = {}
        if not req.get("stream"):
            self._json(200, {
                "id": "fx", "object": "chat.completion", "model": "fixture-model",
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": "同步服务拆分方案"}}],
            })
            return
        delay = self.delay
        if self.delay_file and self.delay_file.exists():
            try:
                delay = float(self.delay_file.read_text().strip())
            except ValueError:
                pass
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def send(delta=None, finish=None, usage=None):
            payload = {"id": "fx", "object": "chat.completion.chunk", "model": "fixture-model",
                       "choices": [{"index": 0, "delta": delta or {}, "finish_reason": finish}]}
            if usage:
                payload["usage"] = usage
                payload["choices"] = []
            self.wfile.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()

        rng = random.Random(7)
        try:
            send({"role": "assistant", "content": ""})
            for part in chunks(self.reasoning, rng):
                send({"reasoning_content": part})
                time.sleep(delay)
            for part in chunks(self.fixture, rng):
                send({"content": part})
                time.sleep(delay * rng.uniform(0.6, 1.4))
            send(finish="stop")
            send(usage={"prompt_tokens": 812, "completion_tokens": 1460, "total_tokens": 2272})
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8799)
    ap.add_argument("--delay", type=float, default=0.035)
    ap.add_argument("--delay-file", type=Path)
    ap.add_argument("--fixture", type=Path, default=HERE / "fixture.md")
    ap.add_argument("--reasoning", default="先确认现状的瓶颈在哪一步,再看拆分后写路径和回执落账的顺序约束,最后给出灰度步骤。")
    args = ap.parse_args()
    Handler.fixture = args.fixture.read_text(encoding="utf-8")
    Handler.reasoning = args.reasoning
    Handler.delay = args.delay
    Handler.delay_file = args.delay_file
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
