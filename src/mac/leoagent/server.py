"""LeoAgent HTTP server — our own control surface on the Mac.

Deliberately small. Hermes remains the general agent engine; this process owns
the thing Hermes has no concept of: hosting *other* coding agents (Claude Code,
Codex, Grok) as long-lived, steerable, approvable sessions.

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
from urllib.parse import urlparse
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiohttp
from aiohttp import web

from . import harness
from .harness import HarnessManager, available_harnesses

VERSION = "0.2.0"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8646


# 中继转发时由 relay_client / Mac 桥接写上调用方类别(手机改不了这个头)。没带这个头的是直接
# 持本机钥匙的调用方(Mac 桥接自己、同 WiFi 直连),与主钥匙同等对待。
CALLER_HEADER = "X-Leo-Caller-Kind"
IDENTIFIED_CALLERS = ("master", "iphone", "legacy")

# [A3] 认不出调用方时 403 的修复办法。只有中继 0.2 起才在转发里带上调用方,手机自己登记
# 设备钥匙解决不了(钥匙本来就对),所以 fix 固定是 mac_steps:要在 Mac 上做的事。
DEVICE_NOT_RECOGNIZED_STEPS = [
    "在运行中继的那台 Mac 上,把中继(relay.py)更新到 0.2 或更新版本并重启中继。",
    "在这台 Mac 上把 LeoPhoneAgent(或 leoagent)更新到最新版,确认它重新连上了中继。",
    "回到手机重发这个任务,全自动就会生效。",
]


def caller_identified(request: web.Request) -> bool:
    kind = request.headers.get(CALLER_HEADER)
    return kind is None or kind in IDENTIFIED_CALLERS


def device_not_recognized(message: str) -> web.Response:
    """403 + 机器可读的原因与修复步骤;message 非空,老客户端照旧把它当原因显示。"""
    return web.json_response({"error": {
        "message": message,
        "code": "device_not_recognized",
        "fix": "mac_steps",
        "steps": DEVICE_NOT_RECOGNIZED_STEPS,
    }}, status=403)


def _phone_session_id(value: Any) -> Optional[str]:
    """手机侧会话 id 只当不透明标签用:字符串、≤200 字符,其余忽略。"""
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value[:200] or None


def _unauthorized() -> web.Response:
    return web.json_response(
        {"error": {"message": "Invalid gateway key", "code": "leoagent_auth_failed"}},
        status=401,
    )


class LeoAgentServer:
    def __init__(self, key: str, home: Optional[Path] = None):
        self.key = key
        self.manager = HarnessManager(home=home)
        # grok_token 的进程内互斥:flock 只隔离跨进程(CLI 自身),同进程的
        # 并发请求必须先在这里排队,否则阻塞的 flock 会冻结整个事件循环。
        self._grok_lock = asyncio.Lock()

    # -- auth --------------------------------------------------------------

    def _authorized(self, request: web.Request) -> bool:
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        try:
            # Constant time: a timing oracle on a bearer token is cheap to avoid.
            # compare_digest raises on non-ASCII, which must read as "denied"
            # rather than escaping as a 500.
            return hmac.compare_digest(header[7:].strip().rstrip("%").strip(), self.key)
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
                "full_auto": True,
            },
            "harnesses": available_harnesses(),
        })

    # [T-grok-via-mac] 手机不再自己跑 xAI OAuth(回环端口回调在 iOS 上易碎),
    # 改为向这台 Mac 借 grok CLI 的登录:返回当前有效 access token,快过期就
    # 先用 CLI 的 refresh_token 刷新并写回 auth.json(拿 auth.json.lock 的
    # flock 与 CLI 自身的刷新互斥——token 会轮转,链条只能有一个持有者)。
    async def grok_token(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return _unauthorized()
        import fcntl
        from datetime import datetime, timezone, timedelta
        auth_path = os.path.expanduser("~/.grok/auth.json")
        if not os.path.exists(auth_path):
            return web.json_response(
                {"error": {"message": "这台 Mac 上的 grok 未登录:在 Mac 终端运行 grok login"}},
                status=502)
        lock_file = open(auth_path + ".lock", "a+")
        try:
            # 两级锁:asyncio.Lock 串行化本进程内的并发请求(flock 对同进程
            # 不同 fd 也互斥,若直接阻塞在事件循环线程上会连锁冻结整个 daemon);
            # flock 本身放到工作线程获取,等 grok CLI 持锁刷新时不冻结事件循环。
            async with self._grok_lock:
                await asyncio.to_thread(fcntl.flock, lock_file, fcntl.LOCK_EX)
                return await self._grok_token_locked(auth_path)
        except Exception as exc:
            return web.json_response(
                {"error": {"message": f"grok token 获取失败: {exc}"}}, status=502)
        finally:
            try:
                fcntl.flock(lock_file, fcntl.LOCK_UN)
                lock_file.close()
            except OSError:
                pass

    async def _grok_token_locked(self, auth_path: str) -> web.Response:
        from datetime import datetime, timezone, timedelta
        with open(auth_path) as f:
            data = json.load(f)
        entry_key = None
        for k, v in data.items():
            if isinstance(v, dict) and v.get("key") and v.get("refresh_token"):
                entry_key = k
                break
        if entry_key is None:
            return web.json_response(
                {"error": {"message": "grok 登录记录不完整:在 Mac 终端重新 grok login"}},
                status=502)
        entry = data[entry_key]
        expires_at = entry.get("expires_at") or ""
        try:
            exp = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError:
            exp = datetime.now(timezone.utc)
        if exp - datetime.now(timezone.utc) < timedelta(minutes=10):
            import aiohttp as _aiohttp
            issuer = str(entry.get("oidc_issuer") or "https://auth.x.ai").rstrip("/")
            issuer_host = urlparse(issuer).hostname or ""
            # refresh token 只发给 xAI 自己的授权服务器,auth.json 被改了也不外发。
            if urlparse(issuer).scheme != "https" or not (issuer_host == "x.ai" or issuer_host.endswith(".x.ai")):
                return web.json_response(
                    {"error": {"message": "grok 登录里的授权地址不是 x.ai,已拒绝刷新:在 Mac 终端重新 grok login。"}},
                    status=502)
            async with aiohttp.ClientSession() as http:
                async with http.get(
                        issuer + "/.well-known/openid-configuration",
                        timeout=aiohttp.ClientTimeout(total=15)) as r:
                    token_endpoint = (await r.json())["token_endpoint"]
                async with http.post(token_endpoint, data={
                        "grant_type": "refresh_token",
                        "refresh_token": entry["refresh_token"],
                        "client_id": str(entry.get("oidc_client_id") or ""),
                }, timeout=aiohttp.ClientTimeout(total=20)) as r:
                    if r.status != 200:
                        detail = (await r.text())[:200]
                        return web.json_response(
                            {"error": {"message": f"grok 登录刷新被拒({r.status}):在 Mac 终端重新 grok login。{detail}"}},
                            status=502)
                    tok = await r.json()
            entry["key"] = tok["access_token"]
            if tok.get("refresh_token"):
                entry["refresh_token"] = tok["refresh_token"]
            new_exp = datetime.now(timezone.utc) + timedelta(seconds=int(tok.get("expires_in") or 3600))
            entry["expires_at"] = new_exp.isoformat().replace("+00:00", "Z")
            tmp = auth_path + ".tmp"
            # 里面有 refresh token:按 0600 建,不跟着 umask 变成 0644。
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                os.fchmod(f.fileno(), 0o600)
                json.dump(data, f, indent=2)
            os.replace(tmp, auth_path)
            exp = new_exp
        return web.json_response({
            "access_token": entry["key"],
            "expires_at": exp.isoformat().replace("+00:00", "Z"),
            "email": entry.get("email") or "",
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
        full_auto = body.get("full_auto") is True
        if full_auto and not caller_identified(request):
            return device_not_recognized("认不出是哪台设备发来的,不能开全自动;按步骤在 Mac 上处理后再试")
        try:
            session = await self.manager.create(
                harness=harness, cwd=cwd, prompt=prompt, full_auto=full_auto,
                phone_session_id=_phone_session_id(body.get("phone_session_id")))
        except (ValueError, RuntimeError) as exc:
            return web.json_response({"error": {"message": str(exc)}}, status=400)
        return web.json_response(
            {"session_id": session.session_id, "harness": harness, "status": session.status,
             "full_auto": session.full_auto},
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
        identified = caller_identified(request)
        wanted = body.get("full_auto")
        if wanted is True and not identified:
            return device_not_recognized("认不出是哪台设备发来的,不能开全自动;按步骤在 Mac 上处理后再试")
        if isinstance(wanted, bool):
            session.full_auto = wanted
        # 全自动的会话不接认不出身份的消息:否则谁拿到中继 0.1 的通道发一句话,就能免审批地跑命令。
        if session.full_auto and not identified:
            return device_not_recognized("这个任务是全自动,认不出是哪台设备发来的消息不接;按步骤在 Mac 上处理后再试")
        phone_session_id = _phone_session_id(body.get("phone_session_id"))
        if phone_session_id:
            session.phone_session_id = phone_session_id
        try:
            await session.send(text)
        except (RuntimeError, OSError) as exc:
            # Dead process, closed stdin, rehydrated session — the client needs
            # a real answer, not a 500 and a silently swallowed message.
            return web.json_response({"error": {"message": str(exc)}}, status=409)
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
        try:
            delivered = await session.respond_to_approval(
                choice, approval_id=str(approval_id) if approval_id else None)
        except OSError:
            # The CLI died with the approval open (its stdin is gone): nothing
            # is waiting any more, which is what 409 tells the phone.
            return web.json_response({"error": {"message": "The session has ended"}}, status=409)
        if not delivered:
            # The card must not clear on the client while the CLI still waits.
            return web.json_response(
                {"error": {"message": "Approval could not be delivered to the CLI"}},
                status=502,
            )
        return web.json_response({"ok": True, "choice": choice, "approval_id": approval_id})

    async def full_auto_off(self, request: web.Request) -> web.Response:
        """手机关掉全自动:还在全自动的会话切回逐项审批(只支持关)。"""
        if not self._authorized(request):
            return _unauthorized()
        try:
            body = await request.json()
        except Exception:
            return web.json_response({"error": {"message": "Invalid JSON"}}, status=400)
        if not isinstance(body, dict) or body.get("enabled") is not False:
            return web.json_response({"error": {"message": '只支持关闭:{"enabled": false}'}}, status=400)
        return web.json_response({"ok": True, "sessions": self.manager.turn_off_full_auto()})

    async def archive(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return _unauthorized()
        session = self.manager.get(request.match_info["session_id"])
        if session is not None and session.status in ("starting", "running", "waiting_for_approval"):
            return web.json_response({"error": {"message": "任务还在跑:先停止,再清理"}}, status=409)
        archived = await self.manager.archive(request.match_info["session_id"])
        if not archived:
            return web.json_response({"error": {"message": "No such session"}}, status=404)
        return web.json_response({"ok": True, "archived": True})

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
        # launchctl kickstart -k restarts us with SIGTERM; without this every
        # spawned CLI outlives the daemon as a detached orphan.
        async def _reap(_app: web.Application) -> None:
            await self.manager.shutdown_all()
        app.on_shutdown.append(_reap)
        app.router.add_get("/health", self.health)
        app.router.add_get("/v1/capabilities", self.capabilities)
        app.router.add_get("/v1/grok/token", self.grok_token)
        app.router.add_get("/harness/sessions", self.list_sessions)
        app.router.add_post("/harness/sessions", self.create_session)
        app.router.add_post("/harness/full-auto", self.full_auto_off)
        app.router.add_get("/harness/sessions/{session_id}/events", self.events)
        app.router.add_post("/harness/sessions/{session_id}/send", self.send)
        app.router.add_post("/harness/sessions/{session_id}/approval", self.approve)
        app.router.add_post("/harness/sessions/{session_id}/stop", self.stop)
        app.router.add_post("/harness/sessions/{session_id}/archive", self.archive)
        return app


class MacBridgeEventSink:
    """把 harness 的关键事件 POST 给本机 LeoPhoneAgent(Mac 桥接),由它推到手机。

    与 relay_client 同样的做法:同步入队、专职协程发送;Mac 没开就留在队里等下次。
    """

    OUTBOX_LIMIT = 200
    # Mac 关着几个小时再开,积压的审批 / 完成早就过时了,一下子全推到手机只是打扰。
    MAX_AGE_S = 10 * 60
    # 只带推送和补齐要用的字段。Claude 的审批帧带着 raw(整份工具输入,Write 一个大文件就是几百 KB),
    # 超过 Mac 接口的上限会被拒,这条审批就永远到不了手机;文件内容也不该经 Mac 进中继。
    KEEP = ("event", "session_id", "seq", "timestamp", "approval_id", "tool", "command",
            "description", "choices", "error", "output", "harness", "phone_session_id")
    FIELD_LIMIT = 2000

    def __init__(self, url: str, key: str) -> None:
        self.url = url
        self.key = key
        self._outbox: List[Dict[str, Any]] = []
        self._wake: Optional[asyncio.Event] = None

    @classmethod
    def slim(cls, event: Dict[str, Any]) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        for key in cls.KEEP:
            value = event.get(key)
            if value is None:
                continue
            out[key] = value[:cls.FIELD_LIMIT] if isinstance(value, str) else value
        return out

    def push(self, event: Dict[str, Any]) -> None:
        if event.get("event") not in harness.PUSHABLE_EVENTS:
            return
        self._outbox.append({**self.slim(event), "_queued_at": time.time()})
        if len(self._outbox) > self.OUTBOX_LIMIT:
            del self._outbox[: len(self._outbox) - self.OUTBOX_LIMIT]
        if self._wake is not None:
            self._wake.set()

    def _next(self) -> Optional[Dict[str, Any]]:
        """队首还没过时的一条;过时的直接丢掉。没有就 None。"""
        now = time.time()
        while self._outbox and now - float(self._outbox[0].get("_queued_at") or 0) > self.MAX_AGE_S:
            self._outbox.pop(0)
        return self._outbox[0] if self._outbox else None

    async def run_forever(self) -> None:
        self._wake = asyncio.Event()
        async with aiohttp.ClientSession() as http:
            while True:
                event = self._next()
                if event is None:
                    await self._wake.wait()
                    self._wake.clear()
                    continue
                payload = {k: v for k, v in event.items() if k != "_queued_at"}
                try:
                    async with http.post(self.url, json={"event": payload},
                                         headers={"Authorization": f"Bearer {self.key}"},
                                         timeout=aiohttp.ClientTimeout(total=10)) as r:
                        # 4xx 重发也不会好(钥匙不对、Mac 版本太旧),丢掉这一条。
                        if r.status < 500:
                            self._outbox.pop(0)
                            continue
                except Exception:  # noqa: BLE001
                    pass
                await asyncio.sleep(15)


def _lan_ip() -> Optional[str]:
    """本机局域网 IP。连一个外网地址(不真发包)让内核选路由源地址。"""
    import socket
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("223.5.5.5", 53))
        ip = probe.getsockname()[0]
        probe.close()
        return ip
    except OSError:
        return None


def _register_bonjour(port: int):
    """Bonjour 广播 _leoagent._tcp,让手机在同一 WiFi 里零配置发现这台 Mac。

    这是产品的主连接方式:不经 SSH、不经 tailnet、不经任何云——手机上直接
    看到"附近的 Mac"。zeroconf 缺失或注册失败只降级为手动填地址,不影响启动。
    """
    try:
        from zeroconf import Zeroconf, ServiceInfo
        import socket
        ip = _lan_ip()
        if not ip:
            return None
        hostname = socket.gethostname().split(".")[0]
        info = ServiceInfo(
            "_leoagent._tcp.local.",
            f"{hostname}._leoagent._tcp.local.",
            addresses=[socket.inet_aton(ip)],
            port=port,
            properties={"platform": "leoagent", "version": VERSION},
        )
        zc = Zeroconf()
        zc.register_service(info)
        print(f"Bonjour: {hostname}._leoagent._tcp @ {ip}:{port}", flush=True)
        return zc
    except Exception as exc:  # noqa: BLE001 — 广播失败绝不能拦启动
        print(f"Bonjour registration skipped: {exc}", flush=True)
        return None


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
    # 非纯回环监听时广播 Bonjour(同 WiFi 零配置直连的加分项)。
    bonjour = None
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        bonjour = _register_bonjour(args.port)

    # relay:主通路。配置了 LEOAGENT_RELAY_URL 就出站挂上去,手机从任何
    # 网络经 relay 找到这台机器——Mac 端不需要公网、不需要 VPN。
    relay_url = os.getenv("LEOAGENT_RELAY_URL", "").strip()

    app = server.build_app()
    if relay_url:
        from .relay_client import RelayClient

        async def _start_relay(started: web.Application) -> None:
            client = RelayClient(relay_url,
                                 os.getenv("LEOAGENT_RELAY_KEY", "").strip() or key,
                                 args.port, key,
                                 # 绑在具体 LAN IP 时 127.0.0.1 上没有监听,
                                 # relay 回打必须走真实绑定地址。
                                 local_host=args.host)
            # [T-leophone-push] 把 harness 的关键事件接到中继通道上:
            # 手机没连着时,这是审批请求唯一的触达路径。
            harness.set_event_sink(client.push_event)
            started["_relay_task"] = asyncio.get_event_loop().create_task(client.run_forever())
        app.on_startup.append(_start_relay)
    else:
        # 切到 Mac 桥接后不再自己注册中继:审批 / 完成事件交给 Mac,由它经中继推给手机。
        sink = MacBridgeEventSink(os.getenv("LEOAGENT_MAC_EVENT_URL", "").strip()
                                  or "http://127.0.0.1:38473/api/leo/link/leoagent-event", key)
        harness.set_event_sink(sink.push)

        async def _start_sink(started: web.Application) -> None:
            started["_mac_sink_task"] = asyncio.get_event_loop().create_task(sink.run_forever())
        app.on_startup.append(_start_sink)
    print(f"LeoAgent {VERSION} listening on http://{args.host}:{args.port}", flush=True)
    try:
        web.run_app(app, host=args.host, port=args.port, print=None)
    finally:
        if bonjour is not None:
            try:
                bonjour.close()
            except Exception:  # noqa: BLE001
                pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
