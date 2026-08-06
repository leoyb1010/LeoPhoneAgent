"""LeoAgent relay — 自营中继,手机从任何网络直达每一台 Mac。

这是 Cindy device-link / Hermes 网关的同构物,跑在自己的常开机上:

    手机(蜂窝/任意 WiFi,零依赖)
        │  https(公网,普通 TLS)
        ▼
    relay(本模块,常开机)
        ▲  出站 WebSocket(穿 NAT,Mac 在哪个网络都能挂上来)
        │
    每台 Mac 的 leoagent 服务(relay_client.py 主动注册)

手机侧只需要一个入口 URL + 一把 relay key;每台 Mac 的名字自动出现在
/relay/api/machines 里。对某台机器的 harness 调用挂在
/relay/api/m/{name}/... 前缀下,路径与 leoagent 本体完全同构——iOS 端
不需要新协议,把 harness 地址指向这个前缀即可。

安全模型:一把 relay key 保护全部端点(个人产品,一把钥匙);Mac 注册用
同一把 key。事件流按帧转发,断线由两端各自重连,手机续传仍靠 ?after=N。
"""

from __future__ import annotations

import argparse
import asyncio
import hmac
import json
import os
import time
import uuid
from typing import Any, Dict, Optional

from aiohttp import WSMsgType, web

VERSION = "0.1.0"
DEFAULT_PORT = 8650
REQUEST_TIMEOUT_S = 60


class Machine:
    def __init__(self, name: str, ws: web.WebSocketResponse, info: Dict[str, Any]):
        self.name = name
        self.ws = ws
        self.info = info
        self.connected_at = time.time()
        # request_id → future(一次性请求)
        self.pending: Dict[str, asyncio.Future] = {}
        # stream_id → queue(事件流)
        self.streams: Dict[str, asyncio.Queue] = {}


class Relay:
    def __init__(self, key: str, extra_keys: Optional[list] = None,
                 rejected_log: Optional[str] = None):
        self.key = key
        # 多钥匙:手机端历史上可能存过任意一台 Mac 的旧钥匙,统一钥匙后
        # 旧钥匙会被拒。RELAY_KEYS 里列出的都放行,老用户无感迁移。
        self.keys = [key] + [k for k in (extra_keys or []) if len(k) >= 16]
        # 被拒的钥匙落盘(0600,仅本机可读),便于把它收编进 RELAY_KEYS。
        self.rejected_log = rejected_log
        self.machines: Dict[str, Machine] = {}

    # -- auth ---------------------------------------------------------------

    def _authorized(self, request: web.Request) -> bool:
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        # 清洗复制残渣:从终端复制密钥时常带上 zsh 的行尾标记 % 或换行。
        # 我们生成的密钥不含这些字符,尾部剥掉是安全的。
        presented = header[7:].strip().rstrip("%").strip()
        try:
            if any(hmac.compare_digest(presented, k) for k in self.keys):
                return True
        except (TypeError, ValueError):
            return False
        self._record_rejected(presented, request.path)
        return False

    def _record_rejected(self, presented: str, path: str) -> None:
        if not self.rejected_log or not presented:
            return
        try:
            import time
            line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {path} {presented}\n"
            fd = os.open(self.rejected_log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a") as f:
                f.write(line)
        except OSError:
            pass

    @staticmethod
    def _unauthorized() -> web.Response:
        return web.json_response(
            {"error": {"message": "Invalid relay key", "code": "relay_auth_failed"}},
            status=401,
        )

    # -- Mac 侧:注册通道 ----------------------------------------------------

    async def agent_ws(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=25)
        await ws.prepare(request)

        machine: Optional[Machine] = None
        try:
            async for msg in ws:
                if msg.type != WSMsgType.TEXT:
                    continue
                try:
                    frame = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                kind = frame.get("type")

                if kind == "register":
                    if not hmac.compare_digest(str(frame.get("key") or ""), self.key):
                        await ws.close(code=4001, message=b"bad key")
                        break
                    name = str(frame.get("name") or "mac")
                    # 同名重连顶掉旧连接(Mac 重启/网络切换后旧 ws 可能半死)
                    old = self.machines.pop(name, None)
                    if old is not None:
                        try:
                            await old.ws.close(code=4000, message=b"replaced")
                        except Exception:  # noqa: BLE001
                            pass
                    machine = Machine(name, ws, dict(frame.get("info") or {}))
                    self.machines[name] = machine
                    print(f"[relay] {name} online", flush=True)
                    await ws.send_json({"type": "registered"})

                elif machine is None:
                    continue  # 未注册前只认 register

                elif kind == "resp":
                    fut = machine.pending.pop(str(frame.get("id")), None)
                    if fut is not None and not fut.done():
                        fut.set_result(frame)

                elif kind in ("stream_data", "stream_close"):
                    queue = machine.streams.get(str(frame.get("id")))
                    if queue is not None:
                        queue.put_nowait(frame)
        finally:
            if machine is not None and self.machines.get(machine.name) is machine:
                del self.machines[machine.name]
                print(f"[relay] {machine.name} offline", flush=True)
                # 挂着的请求全部立刻失败,别让手机等超时
                for fut in machine.pending.values():
                    if not fut.done():
                        fut.set_exception(ConnectionError("machine disconnected"))
                for queue in machine.streams.values():
                    queue.put_nowait({"type": "stream_close", "reason": "machine disconnected"})
        return ws

    # -- 手机侧 --------------------------------------------------------------

    async def health(self, request: web.Request) -> web.Response:
        return web.json_response({"status": "ok", "platform": "leoagent-relay",
                                  "version": VERSION,
                                  "machines": len(self.machines)})

    async def list_machines(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return web.json_response({"machines": [
            {"name": m.name, "online": True, "connected_at": m.connected_at, **m.info}
            for m in self.machines.values()
        ]})

    async def forward(self, request: web.Request) -> web.StreamResponse:
        if not self._authorized(request):
            return self._unauthorized()
        machine = self.machines.get(request.match_info["name"])
        if machine is None:
            return web.json_response(
                {"error": {"message": "这台 Mac 当前不在线(它会自动重连,稍后再试)"}},
                status=502,
            )
        tail = "/" + request.match_info["tail"]
        query = request.query_string
        if query:
            tail = f"{tail}?{query}"

        # 事件流:逐帧转发,其余:一问一答
        if request.method == "GET" and "/events" in tail:
            return await self._forward_stream(request, machine, tail)

        body: Optional[Any] = None
        if request.method in ("POST", "PUT"):
            try:
                body = await request.json()
            except Exception:  # noqa: BLE001
                body = None
        request_id = uuid.uuid4().hex
        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        machine.pending[request_id] = fut
        await machine.ws.send_json({"type": "http", "id": request_id,
                                    "method": request.method, "path": tail,
                                    "body": body})
        try:
            frame = await asyncio.wait_for(fut, timeout=REQUEST_TIMEOUT_S)
        except (asyncio.TimeoutError, ConnectionError):
            machine.pending.pop(request_id, None)
            return web.json_response(
                {"error": {"message": "这台 Mac 没有按时响应"}}, status=504)
        return web.json_response(frame.get("body"), status=int(frame.get("status") or 200))

    async def _forward_stream(self, request: web.Request, machine: Machine,
                              tail: str) -> web.StreamResponse:
        stream_id = uuid.uuid4().hex
        queue: asyncio.Queue = asyncio.Queue(maxsize=1024)
        machine.streams[stream_id] = queue
        response = web.StreamResponse(headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        })
        await response.prepare(request)
        await machine.ws.send_json({"type": "stream_open", "id": stream_id, "path": tail})
        try:
            while True:
                frame = await queue.get()
                if frame.get("type") == "stream_close":
                    break
                data = frame.get("data")
                if data:
                    await response.write(f"data: {data}\n\n".encode("utf-8"))
        except (ConnectionResetError, asyncio.CancelledError):
            pass  # 手机走了;通知 Mac 停推
        finally:
            machine.streams.pop(stream_id, None)
            try:
                await machine.ws.send_json({"type": "stream_cancel", "id": stream_id})
            except Exception:  # noqa: BLE001
                pass
        return response

    # -- wiring ---------------------------------------------------------------

    def build_app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/relay/health", self.health)
        app.router.add_get("/relay/agent", self.agent_ws)
        app.router.add_get("/relay/api/machines", self.list_machines)
        app.router.add_route("*", "/relay/api/m/{name}/{tail:.*}", self.forward)
        return app


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(prog="leoagent-relay")
    parser.add_argument("--host", default=os.getenv("RELAY_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("RELAY_PORT", DEFAULT_PORT)))
    args = parser.parse_args(argv)
    key = os.getenv("RELAY_KEY", "").strip()
    if len(key) < 16:
        print("RELAY_KEY is required and must be at least 16 characters.", flush=True)
        return 2
    extra = [k.strip() for k in os.getenv("RELAY_KEYS", "").split(":") if k.strip()]
    rejected_log = os.path.expanduser("~/.leoagent/relay-rejected.log")
    relay = Relay(key=key, extra_keys=extra, rejected_log=rejected_log)
    print(f"LeoAgent relay {VERSION} on http://{args.host}:{args.port}", flush=True)
    web.run_app(relay.build_app(), host=args.host, port=args.port, print=None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
