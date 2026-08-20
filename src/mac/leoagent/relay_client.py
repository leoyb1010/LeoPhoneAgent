"""relay_client — 每台 Mac 出站挂上自营 relay,让手机随时随地找得到它。

出站 WebSocket 意味着这台 Mac 可以在任何网络里(家里/公司/热点),不需要
公网 IP、不需要端口映射、不需要 VPN。断线按指数退避永久重连——"服务在线"
不依赖人守着。

收到 relay 转发的请求后,直接打回本机 leoagent(127.0.0.1)执行;事件流
逐条回推。协议帧与 relay.py 对偶。
"""

from __future__ import annotations

import asyncio
import json
import socket
from typing import List, Any, Dict, Optional

import aiohttp

LOCAL_BASE = "http://{host}:{port}"


class RelayClient:
    def __init__(self, relay_url: str, relay_key: str, local_port: int, local_key: str,
                 name: Optional[str] = None, local_host: str = "127.0.0.1"):
        # ws 地址:接受 https://…/relay/agent 或省略路径的根地址
        url = relay_url.rstrip("/")
        if not url.endswith("/relay/agent"):
            url = url + "/relay/agent"
        self.ws_url = url.replace("https://", "wss://").replace("http://", "ws://")
        self.relay_key = relay_key
        # server 绑在具体 LAN IP(Bonjour 模式)时 127.0.0.1 上没有监听,
        # 回打必须用真实绑定地址;通配地址(0.0.0.0/::)则回环最稳。
        if local_host in ("", "0.0.0.0", "::"):
            local_host = "127.0.0.1"
        self.local_base = LOCAL_BASE.format(host=local_host, port=local_port)
        self.local_key = local_key
        self.name = name or socket.gethostname().split(".")[0]
        # stream_id → cancel event
        self._stream_cancels: Dict[str, asyncio.Event] = {}
        # [T-leophone-push] 当前活动连接 + 断线期间的事件暂存。
        # 手机没连着时 SSE 通道根本不存在,审批请求只躺在本机日志里——
        # 这条外推是它唯一的触达路径,所以推不出去要留着补发,不能丢。
        self._ws: Optional[Any] = None
        self._outbox: List[Dict[str, Any]] = []
        self._wake: Optional[asyncio.Event] = None
        # [T-task-gc] 持有在飞的任务引用。asyncio 只保弱引用,不持有的
        # 任务可能被 GC 中途回收——症状是请求偶发无响应且毫无日志。
        self._tasks: set = set()

    OUTBOX_LIMIT = 200

    def push_event(self, event: Dict[str, Any]) -> None:
        """把一条关键事件外推给中继。

        同步、非阻塞:只入队并唤醒发送协程。不在这里直接 create_task 发送,
        原因有二 —— 裸 create_task 的任务没人持引用,可能被 GC 中途回收
        (事件就这么没了);而且任务内部发送失败无处回退,同样丢事件。
        队列 + 专职发送协程同时解决顺序、引用与失败回退三件事。
        """
        self._outbox.append({"type": "event", "machine": self.name, "event": event})
        if len(self._outbox) > self.OUTBOX_LIMIT:
            del self._outbox[: len(self._outbox) - self.OUTBOX_LIMIT]
        wake = self._wake
        if wake is not None and not wake.is_set():
            try:
                wake.set()
            except RuntimeError:
                pass  # 不在事件循环里,等下次连接时一并补发

    async def _sender_loop(self, ws) -> None:
        """专职发送协程:队列里有货就按序发出去,发不动就放回队首等重连。"""
        assert self._wake is not None
        while True:
            await self._wake.wait()
            self._wake.clear()
            while self._outbox:
                frame = self._outbox[0]
                try:
                    await ws.send_json(frame)
                except asyncio.CancelledError:
                    raise
                except (TypeError, ValueError) as exc:
                    # 序列化失败(帧里混进了不可 JSON 化的东西)。这跟"连接坏了"
                    # 完全不是一回事:留在队首的话它永远发不出去,而它后面的
                    # **所有**审批请求、任务终态、APNs 推送就此永久堵死,而且
                    # 全程静默。丢掉这一帧、记一条日志,继续发后面的。
                    self._outbox.pop(0)
                    print(f"[relay-client] dropped unserializable frame: {exc}", flush=True)
                    continue
                except Exception:  # noqa: BLE001
                    return  # 连接坏了:留在队列里,重连后继续
                self._outbox.pop(0)

    async def run_forever(self) -> None:
        backoff = 1
        while True:
            try:
                await self._run_once()
                backoff = 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — 任何断因都只是重连
                print(f"[relay-client] disconnected: {exc}", flush=True)
            finally:
                self._ws = None
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def _run_once(self) -> None:
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(self.ws_url, heartbeat=25) as ws:
                await ws.send_json({"type": "register", "name": self.name,
                                    "key": self.relay_key,
                                    "info": {"platform": "leoagent"}})
                print(f"[relay-client] connected to relay as {self.name}", flush=True)
                self._ws = ws
                self._wake = asyncio.Event()
                if self._outbox:
                    # 断线期间攒下的先补发
                    self._wake.set()
                    print(f"[relay-client] {len(self._outbox)} queued event(s) to flush", flush=True)
                sender = asyncio.create_task(self._sender_loop(ws))
                try:
                    await self._consume(ws, session)
                finally:
                    sender.cancel()
                    # cancel() 只是"排了个取消",不 await 的话任务还在飞:
                    # 解释器退出时会甩一条 "Task was destroyed but it is
                    # pending",更糟的是它可能还往一个正在关闭的 ws 上写。
                    # 用 asyncio.wait 而不是 `await sender`:前者不会把
                    # 被取消任务的 CancelledError 冒到这里。
                    await asyncio.wait({sender})
                    self._wake = None
                # relay 主动关连接时(如 key 校验失败的 4001),async for 会
                # "正常"结束——不抛错的话 run_forever 会把退避重置回 1 秒,
                # 变成每秒打一次日志的静默风暴,且 close 原因完全丢失。
                if ws.close_code and ws.close_code >= 4000:
                    reason = (ws.close_message or b"").decode("utf-8", "replace")
                    raise RuntimeError(
                        f"relay rejected connection (close={ws.close_code} {reason!r})"
                        +(":检查 LEOAGENT_RELAY_KEY 是否与 relay 一致" if ws.close_code == 4001 else ""))
                return

    async def _consume(self, ws, session) -> None:
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            try:
                frame = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            kind = frame.get("type")
            if kind == "http":
                self._spawn(self._handle_http(session, ws, frame))
            elif kind == "stream_open":
                self._spawn(self._handle_stream(session, ws, frame))
            elif kind == "stream_cancel":
                cancel = self._stream_cancels.get(str(frame.get("id")))
                if cancel is not None:
                    cancel.set()

    def _spawn(self, coro) -> None:
        """起一个后台任务并持住引用,完成后自动摘除。"""
        task = asyncio.get_running_loop().create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.local_key}"}

    async def _handle_http(self, session: aiohttp.ClientSession,
                           ws: aiohttp.ClientWebSocketResponse,
                           frame: Dict[str, Any]) -> None:
        request_id = frame.get("id")
        method = str(frame.get("method") or "GET").upper()
        path = str(frame.get("path") or "/")
        body = frame.get("body")
        try:
            async with session.request(
                method, self.local_base + path,
                json=body if body is not None else None,
                headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=55),
            ) as resp:
                try:
                    payload = await resp.json()
                except Exception:  # noqa: BLE001
                    payload = {"raw": await resp.text()}
                await ws.send_json({"type": "resp", "id": request_id,
                                    "status": resp.status, "body": payload})
        except Exception as exc:  # noqa: BLE001
            await ws.send_json({"type": "resp", "id": request_id, "status": 502,
                                "body": {"error": {"message": f"local call failed: {exc}"}}})

    async def _handle_stream(self, session: aiohttp.ClientSession,
                             ws: aiohttp.ClientWebSocketResponse,
                             frame: Dict[str, Any]) -> None:
        stream_id = str(frame.get("id"))
        path = str(frame.get("path") or "/")
        cancel = asyncio.Event()
        self._stream_cancels[stream_id] = cancel
        cancel_wait = asyncio.ensure_future(cancel.wait())
        try:
            async with session.get(
                self.local_base + path, headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=None, sock_read=3600),
            ) as resp:
                while True:
                    # 不能写成 `async for raw in resp.content`。那样 cancel 只在
                    # "下一行到达之后"才被看见,而 SSE 空闲流可能几十分钟不出一行
                    # ——sock_read=3600 意味着手机关掉面板后,这条上游连接最长还要
                    # 挂一个小时。这里让读和 cancel 赛跑,取消立刻生效。
                    read = asyncio.ensure_future(resp.content.readline())
                    done, _ = await asyncio.wait(
                        {read, cancel_wait}, return_when=asyncio.FIRST_COMPLETED)
                    if read not in done:
                        read.cancel()
                        break
                    raw = read.result()
                    if not raw:
                        break
                    line = raw.decode("utf-8", errors="replace").strip()
                    # 本机是 SSE 帧("data: {...}"),剥前缀转纯数据帧
                    if line.startswith("data: "):
                        await ws.send_json({"type": "stream_data", "id": stream_id,
                                            "data": line[6:]})
                    elif line.startswith(":"):
                        # 本机每 25 秒发一个 `: keep-alive` 注释帧。旧代码只转
                        # `data:`,把它整个丢了 —— 于是"中继→手机"这一段完全没有
                        # 保活,长时间无事件的会话会被中间的代理/NAT 静默掐断,
                        # 表现成手机端莫名其妙掉线。转成保活帧继续往下传。
                        await ws.send_json({"type": "stream_keepalive", "id": stream_id})
        except Exception as exc:  # noqa: BLE001
            print(f"[relay-client] stream {stream_id} error: {exc}", flush=True)
        finally:
            cancel_wait.cancel()
            self._stream_cancels.pop(stream_id, None)
            try:
                await ws.send_json({"type": "stream_close", "id": stream_id})
            except Exception:  # noqa: BLE001
                pass


_BACKGROUND_TASKS: set = set()


def start_in_background(relay_url: str, relay_key: str, local_port: int,
                        local_key: str, local_host: str = "127.0.0.1") -> None:
    """在 server 的事件循环里常驻。失败只影响 relay 通路,不影响本机服务。"""
    client = RelayClient(relay_url, relay_key, local_port, local_key,
                         local_host=local_host)
    # 模块级持引用:这条任务是整个 Mac↔中继链路,被 GC 即静默死亡。
    # 挂在 client 自己身上是循环引用,gc 照样能收;必须有外部根。
    task = asyncio.create_task(client.run_forever())
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
