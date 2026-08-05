"""LeoAgent HTTP server — our own control surface on the Mac.

Deliberately small. Hermes remains the general agent engine; this process owns
the thing Hermes has no concept of: hosting *other* coding agents (Claude Code,
Codex, pi, Grok) as long-lived, steerable, approvable sessions.

Two properties this has that the Hermes api_server does not:

1. **Resumable event streams.** Every session's events are appended to an
   NDJSON log with a monotonic seq, and `/harness/{id}/events?after=N` replays
   from that point before following live. Hermes' SSE stream is one-shot and
   destructive — a phone that loses signal loses those events permanently.
2. **Harness sessions.** A run here is a real coding agent working in a real
   directory, not a single-shot prompt.

Auth mirrors the gateway it sits beside: a bearer token, compared in constant
time, required on everything except /health.
"""

from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import os
from pathlib import Path
from typing import Any, Optional

from aiohttp import web

from .harness import HarnessManager, available_harnesses

VERSION = "0.1.0"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8646


def _unauthorized() -> web.Response:
    return web.json_response(
        {"error": {"message": "Invalid gateway key", "code": "leoagent_auth_failed"}},
        status=401,
    )


class LeoAgentServer:
    def __init__(self, key: str, home: Optional[Path] = None):
        self.key = key
        self.manager = HarnessManager(home=home)

    # -- auth --------------------------------------------------------------

    def _authorized(self, request: web.Request) -> bool:
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        try:
            # Constant time: a timing oracle on a bearer token is cheap to avoid.
            # compare_digest raises on non-ASCII, which must read as "denied"
            # rather than escaping as a 500.
            return hmac.compare_digest(header[7:].strip(), self.key)
        except (TypeError, ValueError):
            return False

    # -- handlers ----------------------------------------------------------

    async def health(self, request: web.Request) -> web.Response:
        return web.json_response({"status": "ok", "platform": "leoagent", "version": VERSION})

    async def capabilities(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return _unauthorized()
        return web.json_response({
            "object": "leoagent.capabilities",
            "platform": "leoagent",
            "version": VERSION,
            "features": {
                "harness_sessions": True,
                # The differentiator, stated plainly so a client can rely on it.
                "resumable_events": True,
                "approval_events": True,
                "session_steering": True,
            },
            "harnesses": available_harnesses(),
        })

    async def create_session(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return _unauthorized()
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": {"message": "Invalid JSON"}}, status=400)
        harness = str(body.get("harness") or "")
        cwd = str(body.get("cwd") or os.path.expanduser("~"))
        prompt = body.get("prompt")
        try:
            session = await self.manager.create(harness=harness, cwd=cwd, prompt=prompt)
        except (ValueError, RuntimeError) as exc:
            return web.json_response({"error": {"message": str(exc)}}, status=400)
        return web.json_response(
            {"session_id": session.session_id, "harness": harness, "status": session.status},
            status=202,
        )

    async def list_sessions(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return _unauthorized()
        return web.json_response({"sessions": self.manager.list()})

    async def events(self, request: web.Request) -> web.StreamResponse:
        if not self._authorized(request):
            return _unauthorized()
        session = self.manager.get(request.match_info["session_id"])
        if session is None:
            return web.json_response({"error": {"message": "No such session"}}, status=404)
        try:
            after = int(request.query.get("after", "0"))
        except ValueError:
            after = 0

        response = web.StreamResponse(
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                # Proxies that buffer would defeat the whole point.
                "X-Accel-Buffering": "no",
            }
        )
        await response.prepare(request)
        try:
            async for event in session.subscribe(after_seq=after):
                payload = json.dumps(event, ensure_ascii=False)
                await response.write(f"data: {payload}\n\n".encode("utf-8"))
        except (ConnectionResetError, asyncio.CancelledError):
            # A client that walked away is normal; the session keeps running
            # and its log keeps growing, so the client can resume by seq.
            pass
        return response

    async def send(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return _unauthorized()
        session = self.manager.get(request.match_info["session_id"])
        if session is None:
            return web.json_response({"error": {"message": "No such session"}}, status=404)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": {"message": "Invalid JSON"}}, status=400)
        text = str(body.get("text") or "")
        if not text:
            return web.json_response({"error": {"message": "text is required"}}, status=400)
        await session.send(text)
        return web.json_response({"ok": True, "seq": session.seq})

    async def approve(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return _unauthorized()
        session = self.manager.get(request.match_info["session_id"])
        if session is None:
            return web.json_response({"error": {"message": "No such session"}}, status=404)
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": {"message": "Invalid JSON"}}, status=400)
        choice = str(body.get("choice") or "").lower()
        approval_id = body.get("approval_id")
        if approval_id:
            pending = session.pending_approvals.get(str(approval_id))
        elif len(session.pending_approvals) == 1:
            approval_id, pending = next(iter(session.pending_approvals.items()))
        else:
            pending = None
        if pending is None:
            return web.json_response(
                {"error": {"message": "No such pending approval"}}, status=409)
        allowed = pending.get("choices") or ["once", "deny"]
        if choice not in allowed:
            return web.json_response(
                {"error": {"message": f"Invalid choice; expected one of: {', '.join(allowed)}"}},
                status=400,
            )
        await session.respond_to_approval(choice, approval_id=str(approval_id) if approval_id else None)
        return web.json_response({"ok": True, "choice": choice, "approval_id": approval_id})

    async def stop(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return _unauthorized()
        session = self.manager.get(request.match_info["session_id"])
        if session is None:
            return web.json_response({"error": {"message": "No such session"}}, status=404)
        await session.stop()
        return web.json_response({"ok": True, "status": session.status})

    # -- wiring ------------------------------------------------------------

    def build_app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/health", self.health)
        app.router.add_get("/v1/capabilities", self.capabilities)
        app.router.add_get("/harness/sessions", self.list_sessions)
        app.router.add_post("/harness/sessions", self.create_session)
        app.router.add_get("/harness/sessions/{session_id}/events", self.events)
        app.router.add_post("/harness/sessions/{session_id}/send", self.send)
        app.router.add_post("/harness/sessions/{session_id}/approval", self.approve)
        app.router.add_post("/harness/sessions/{session_id}/stop", self.stop)
        return app


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(prog="leoagent", description="LeoAgent harness server")
    parser.add_argument("--host", default=os.getenv("LEOAGENT_HOST", DEFAULT_HOST))
    parser.add_argument("--port", type=int, default=int(os.getenv("LEOAGENT_PORT", DEFAULT_PORT)))
    parser.add_argument("--home", default=os.getenv("LEOAGENT_HOME"))
    args = parser.parse_args(argv)

    key = os.getenv("LEOAGENT_KEY", "").strip()
    if len(key) < 16:
        # Refusing to start is the right failure: a permissive default here
        # would expose every coding agent on this Mac to anyone who can reach
        # the port. Same stance the Hermes api_server takes with its own key.
        print("LEOAGENT_KEY is required and must be at least 16 characters.", flush=True)
        return 2

    home = Path(args.home).expanduser() if args.home else None
    server = LeoAgentServer(key=key, home=home)
    print(f"LeoAgent {VERSION} listening on http://{args.host}:{args.port}", flush=True)
    web.run_app(server.build_app(), host=args.host, port=args.port, print=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
