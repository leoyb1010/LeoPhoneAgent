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
from typing import Any, Dict, List, Optional

from aiohttp import WSMsgType, web

from .apns import build_pusher

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
        # [T-leophone-push] Mac 主动外推的关键事件(审批请求、任务终态)。
        # 手机拉 SSE 只在它连着时才收得到;这里留一份最近事件,手机回来
        # 一次就能补齐"我不在的时候发生了什么"。也是将来接 APNs 的取数处。
        self.recent_events: List[Dict[str, Any]] = []
        self.event_waiters: List[asyncio.Future] = []
        # [T-live-mission] APNs 推送器。没配 ~/.leoagent/apns.json 就整体
        # 禁用,中继本体照常工作(降级而非报错)。
        self.apns = build_pusher()
        # 后台任务引用集(防 GC,见 _push_apns 调用处)
        self._bg_tasks: set = set()
        # [T-collections-fleet] 手机上传的收藏索引(只读镜像)
        self.collections: List[Dict[str, Any]] = []
        self.collections_updated_at: float = 0.0
        try:
            with open(os.path.expanduser("~/.leoagent/collections.json")) as f:
                saved = json.load(f)
            self.collections = list(saved.get("items") or [])
            self.collections_updated_at = float(saved.get("updated_at") or 0)
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass

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
                        try:
                            queue.put_nowait(frame)
                        except asyncio.QueueFull:
                            # 手机端读得慢时丢这一帧。绝不能让 QueueFull
                            # 冲出消息循环——那会注销整台 Mac 的中继连接,
                            # 一条慢流拖死全部功能。
                            pass

                elif kind == "event":
                    # [T-leophone-push] Mac 主动上报的关键事件。手机不在线
                    # 时这是唯一的留痕;上限内保最近的。
                    self._record_event(str(frame.get("machine") or machine.name),
                                       dict(frame.get("event") or {}))
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

    # -- 事件缓冲 -------------------------------------------------------------

    MAX_EVENTS = 200

    def _record_event(self, machine_name: str, event: Dict[str, Any]) -> None:
        item = {
            "machine": machine_name,
            "received_at": time.time(),
            "event": event,
        }
        self.recent_events.append(item)
        if len(self.recent_events) > self.MAX_EVENTS:
            del self.recent_events[: len(self.recent_events) - self.MAX_EVENTS]
        # 唤醒所有等着的手机
        for fut in self.event_waiters:
            if not fut.done():
                fut.set_result(None)
        self.event_waiters.clear()
        kind = event.get("event", "?")
        print(f"[relay] event {kind} from {machine_name}", flush=True)
        # [T-live-mission] 关键事件转 APNs:app 完全没运行时的唯一触达路径。
        if self.apns.enabled:
            # 持引用!事件循环只持任务弱引用,裸 create_task 的协程挂在
            # APNs 网络 I/O 上时可能被 GC 中途回收——推送静默消失。
            # relay_client.push_event 修过同一类 bug,这里不能复发。
            task = asyncio.get_running_loop().create_task(
                self._push_apns(machine_name, event))
            self._bg_tasks.add(task)
            task.add_done_callback(self._bg_tasks.discard)

    async def _push_apns(self, machine_name: str, event: Dict[str, Any]) -> None:
        kind = event.get("event")
        try:
            if kind == "approval.request":
                await self.apns.send_alert(
                    title=f"🖥 {machine_name} 等你审批",
                    body=str(event.get("command") or "")[:200],
                    user_info={
                        "harnessApproval": True,
                        "machine": machine_name,
                        "harnessSessionId": str(event.get("session_id") or ""),
                        "approvalId": str(event.get("approval_id") or ""),
                    },
                    category="HARNESS_APPROVAL",
                    time_sensitive=True,
                )
            elif kind == "run.failed":
                await self.apns.send_alert(
                    title=f"🖥 {machine_name} 任务失败",
                    body=str(event.get("error") or "")[:200],
                    user_info={"harnessSessionId": str(event.get("session_id") or "")},
                )
            elif kind == "run.completed":
                await self.apns.send_alert(
                    title=f"✅ {machine_name} 任务完成",
                    body=str(event.get("output") or "任务已结束")[:200],
                    user_info={"harnessSessionId": str(event.get("session_id") or "")},
                )
        except Exception as exc:  # noqa: BLE001
            print(f"[relay] apns push failed: {exc}", flush=True)

    async def put_collections(self, request: web.Request) -> web.Response:
        """[T-collections-fleet] 手机上传收藏索引,Mac 端据此查看。

        收藏本体在手机上(附件、正文都在手机沙盒里),这里只存一份可读的
        索引:标题、来源、摘要、标签、链接。Mac 上看得见、点得开原链接,
        但不复制手机的私有文件——最小必要。
        """
        if not self._authorized(request):
            return self._unauthorized()
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"error": {"message": "invalid json"}}, status=400)
        items = body.get("items")
        if not isinstance(items, list):
            return web.json_response({"error": {"message": "items must be a list"}}, status=400)
        self.collections = items[:500]
        self.collections_updated_at = time.time()
        try:
            # tmp+replace 原子写:O_TRUNC 原地写在崩溃时会留半截坏 JSON
            path = os.path.expanduser("~/.leoagent/collections.json")
            tmp = path + ".tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump({"items": self.collections,
                           "updated_at": self.collections_updated_at}, f, ensure_ascii=False)
            os.replace(tmp, path)
        except OSError:
            pass  # 落盘失败只丢重启后的持久性,内存里仍可读
        return web.json_response({"ok": True, "count": len(self.collections)})

    async def get_collections(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        return web.json_response({
            "items": self.collections,
            "updated_at": self.collections_updated_at,
        })

    async def register_device(self, request: web.Request) -> web.Response:
        """手机登记推送 token。kind ∈ {device, push_to_start}。"""
        if not self._authorized(request):
            return self._unauthorized()
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"error": {"message": "invalid json"}}, status=400)
        ok = self.apns.register(
            kind=str(body.get("kind") or "device"),
            token=str(body.get("token") or ""),
            bundle_id=str(body.get("bundle_id") or ""),
            environment=str(body.get("environment") or "development"),
        )
        if not ok:
            return web.json_response({"error": {"message": "bad token payload"}}, status=400)
        return web.json_response({"ok": True, "apns": self.apns.status()})

    async def push_status(self, request: web.Request) -> web.Response:
        """诊断:推送为什么没生效,一眼看得出来。"""
        if not self._authorized(request):
            return self._unauthorized()
        return web.json_response(self.apns.status())

    async def list_events(self, request: web.Request) -> web.Response:
        """手机取最近事件。?after=<received_at> 只取更新的;?wait=1 长轮询。

        这是"手机不在线时错过的事情"的补齐口:回到前台先拉一次,就知道
        有没有待审批、哪个任务结束了。
        """
        if not self._authorized(request):
            return self._unauthorized()
        try:
            after = float(request.query.get("after", "0") or 0)
        except ValueError:
            after = 0.0

        def newer() -> List[Dict[str, Any]]:
            return [e for e in self.recent_events if e["received_at"] > after]

        items = newer()
        if not items and request.query.get("wait") == "1":
            # 长轮询:最多挂 25 秒,期间来了新事件立刻返回
            loop = asyncio.get_running_loop()
            fut: asyncio.Future = loop.create_future()
            self.event_waiters.append(fut)
            try:
                await asyncio.wait_for(fut, timeout=25)
            except asyncio.TimeoutError:
                pass
            finally:
                if fut in self.event_waiters:
                    self.event_waiters.remove(fut)
            items = newer()

        return web.json_response({
            "events": items,
            "now": time.time(),
        })

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
        app.router.add_get("/relay/api/events", self.list_events)
        app.router.add_post("/relay/api/device", self.register_device)
        app.router.add_get("/relay/api/push-status", self.push_status)
        app.router.add_put("/relay/api/collections", self.put_collections)
        app.router.add_get("/relay/api/collections", self.get_collections)
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
