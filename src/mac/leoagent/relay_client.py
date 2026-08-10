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

LOCAL_BASE = "http://127.0.0.1:{port}"


class RelayClient:
    def __init__(self, relay_url: str, relay_key: str, local_port: int, local_key: str,
                 name: Optional[str] = None):
        # ws 地址:接受 https://…/relay/agent 或省略路径的根地址
        url = relay_url.rstrip("/")
        if not url.endswith("/relay/agent"):
            url = url + "/relay/agent"
        self.ws_url = url.replace("https://", "wss://").replace("http://", "ws://")
        self.relay_key = relay_key
        self.local_base = LOCAL_BASE.format(port=local_port)
        self.local_key = local_key
        self.name = name or socket.gethostname().split(".")[0]
        # stream_id → cancel event
        self._stream_cancels: Dict[str, asyncio.Event] = {}
        # [T-leophone-push] 当前活动连接 + 断线期间的事件暂存。
        # 手机没连着时 SSE 通道根本不存在,审批请求只躺在本机日志里——
        # 这条外推是它唯一的触达路径,所以推不出去要留着补发,不能丢。
        self._ws: Optional[Any] = None
        self._outbox: List[Dict[str, Any]] = []

    OUTBOX_LIMIT = 200

    def push_event(self, event: Dict[str, Any]) -> None:
        """把一条关键事件外推给中继。非阻塞,失败落队列等重连补发。"""
        frame = {"type": "event", "machine": self.name, "event": event}
        ws = self._ws
        if ws is not None and not ws.closed:
            try:
                asyncio.get_running_loop().create_task(ws.send_json(frame))
                return
            except RuntimeError:
                pass
            except Exception:  # noqa: BLE001
                pass
        self._outbox.append(frame)
        if len(self._outbox) > self.OUTBOX_LIMIT:
            del self._outbox[: len(self._outbox) - self.OUTBOX_LIMIT]

    async def _flush_outbox(self, ws) -> None:
        if not self._outbox:
            return
        pending = self._outbox[:]
        self._outbox.clear()
        for frame in pending:
            try:
                await ws.send_json(frame)
            except Exception:  # noqa: BLE001
                self._outbox.append(frame)
        sent = len(pending) - len(self._outbox)
        if sent:
            print(f"[relay-client] flushed {sent} queued event(s)", flush=True)

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
                await self._flush_outbox(ws)
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        continue
                    try:
                        frame = json.loads(msg.data)
                    except json.JSONDecodeError:
                        continue
                    kind = frame.get("type")
                    if kind == "http":
                        asyncio.create_task(self._handle_http(session, ws, frame))
                    elif kind == "stream_open":
                        asyncio.create_task(self._handle_stream(session, ws, frame))
                    elif kind == "stream_cancel":
                        cancel = self._stream_cancels.get(str(frame.get("id")))
                        if cancel is not None:
                            cancel.set()

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
        try:
            async with session.get(
                self.local_base + path, headers=self._headers(),
                timeout=aiohttp.ClientTimeout(total=None, sock_read=3600),
            ) as resp:
                async for raw in resp.content:
                    if cancel.is_set():
                        break
                    line = raw.decode("utf-8", errors="replace").strip()
                    # 本机是 SSE 帧("data: {...}"),剥前缀转纯数据帧
                    if line.startswith("data: "):
                        await ws.send_json({"type": "stream_data", "id": stream_id,
                                            "data": line[6:]})
        except Exception as exc:  # noqa: BLE001
            print(f"[relay-client] stream {stream_id} error: {exc}", flush=True)
        finally:
            self._stream_cancels.pop(stream_id, None)
            try:
                await ws.send_json({"type": "stream_close", "id": stream_id})
            except Exception:  # noqa: BLE001
                pass


def start_in_background(relay_url: str, relay_key: str, local_port: int,
                        local_key: str) -> None:
    """在 server 的事件循环里常驻。失败只影响 relay 通路,不影响本机服务。"""
    client = RelayClient(relay_url, relay_key, local_port, local_key)
    asyncio.get_event_loop().create_task(client.run_forever())
