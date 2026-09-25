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

安全模型(0.2):
- 每台手机一把设备钥匙,中继只存哈希;iPhone 的设备钥匙只能访问客户端接口,
  Android / 鸿蒙的"旧版设备钥匙"还能注册未钉扎的机器名。设备钥匙都不能签发一次性码。
- 主钥匙(RELAY_KEY)在轮换前全权有效;轮换后再有效 30 天,到期作废。
  轮换同时生成"Mac 注册钥匙":只能注册机器、领取机器专属钥匙。
- 机器名钉扎:Mac 首次注册时带 pin=true 领取机器专属钥匙,之后这个名字只认它。
- 配对:iPhone 用的一次性码兑换后进入待定,Mac 点允许才发钥匙;给 Android / 鸿蒙的
  旧式短码兑换即发旧版设备钥匙(与 0.1 一致)。兑换接口按来源限速。
- 转发给 Mac 的请求带上调用方类别(caller),Mac 据此决定能不能开全自动等。
- 发给离线 Mac 的建任务 / 发送请求可以排队(X-Leo-Queue: 1),Mac 上线即投递。
事件流按帧转发(正文增量 message.delta 每 60 ms 合成一条),断线由两端各自重连,
手机续传仍靠 ?after=N。
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import os
import secrets
import time
import uuid
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

from aiohttp import WSMsgType, web

from .apns import build_pusher

VERSION = "0.2.0"
DEFAULT_PORT = 8650
REQUEST_TIMEOUT_S = 60
# 同一条事件流里的 message.delta 最多每 60 ms 合成一条发给手机:逐 token 转发的话,
# 一轮回答就是几百个 SSE 事件,手机每条都要解析、重绘,蜂窝网络下还费电。
DELTA_COALESCE_S = 0.06
JOIN_TTL_S = 5 * 60
DEVICE_KEY_TTL_S = 90 * 24 * 3600          # 滑动:用一次续一次
MASTER_GRACE_S = 30 * 24 * 3600            # 轮换后旧主钥匙再有效多久
QUEUE_TTL_S = 24 * 3600
QUEUE_LIMIT_PER_MACHINE = 200
JOIN_FAIL_LIMIT = 5                        # 同一来源 60 秒内失败这么多次就暂停
JOIN_FAIL_WINDOW_S = 60
DEFAULT_DEVICE_KEYS_PATH = os.path.expanduser("~/.leoagent/device-keys.json")
DEFAULT_STATE_PATH = os.path.expanduser("~/.leoagent/relay-state.json")
DEFAULT_TREASURY_SYNC_PATH = os.path.expanduser("~/.leoagent/treasury-sync.json")
TREASURY_CHANGE_LIMIT = 50_000
TREASURY_SEEN_CHANGE_LIMIT = 200_000
TREASURY_BATCH_LIMIT = 500
TREASURY_ITEM_LIMIT = 50_000
TREASURY_ASSET_REQUEST_LIMIT = 10_000
TREASURY_BODY_LIMIT = 8 * 1024 * 1024
TREASURY_ATTACHMENT_LIMIT = 128 * 1024 * 1024
TREASURY_ASSET_TTL_S = 30 * 24 * 3600


class Caller:
    """一次请求的调用方。kind ∈ master / register / iphone / legacy / machine。"""

    __slots__ = ("kind", "device_id", "name", "machine")

    def __init__(self, kind: str, device_id: Optional[str] = None,
                 name: Optional[str] = None, machine: Optional[str] = None):
        self.kind = kind
        self.device_id = device_id
        self.name = name
        self.machine = machine

    @property
    def is_client(self) -> bool:
        return self.kind in ("master", "iphone", "legacy")

    @property
    def is_admin(self) -> bool:
        """能管理配对与设备:主钥匙或机器专属钥匙。"""
        return self.kind in ("master", "machine")

    def public(self) -> Dict[str, str]:
        return {"kind": self.kind, "device_id": self.device_id or "", "name": self.name or ""}


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
                 rejected_log: Optional[str] = None,
                 device_keys_path: Optional[str] = None,
                 treasury_sync_path: Optional[str] = None,
                 treasury_asset_dir: Optional[str] = None,
                 state_path: Optional[str] = None):
        self.key = key
        # 多钥匙:手机端历史上可能存过任意一台 Mac 的旧钥匙,统一钥匙后
        # 旧钥匙会被拒。RELAY_KEYS 里列出的都放行,老用户无感迁移。
        self.keys = [key] + [k for k in (extra_keys or []) if len(k) >= 16]
        # 0.2 身份状态:设备记录(只存钥匙哈希)、机器名钉扎、注册钥匙、主钥匙到期时间。
        # 0.1 的 device-keys.json 在首次启动时原样迁成旧版设备。
        self.device_keys_path = device_keys_path or DEFAULT_DEVICE_KEYS_PATH
        self.state_path = state_path or (
            os.path.join(os.path.dirname(device_keys_path), "relay-state.json")
            if device_keys_path else DEFAULT_STATE_PATH)
        self.devices: Dict[str, Dict[str, Any]] = {}
        self.device_by_hash: Dict[str, str] = {}
        self.pins: Dict[str, str] = {}
        self.register_key_hash: Optional[str] = None
        self.master_expires_at: Optional[float] = None
        self.join_tokens: Dict[str, Dict[str, Any]] = {}
        self.pending_joins: Dict[str, Dict[str, Any]] = {}
        self.join_failures: Dict[str, List[float]] = {}
        self.offline_queue: Dict[str, List[Dict[str, Any]]] = {}
        self.queue_results: Dict[str, Dict[str, Any]] = {}
        self._last_touch_persist = 0.0
        self._load_state()
        # 被拒的钥匙落盘(0600,仅本机可读),便于把它收编进 RELAY_KEYS。
        self.rejected_log = rejected_log
        self._last_rejected_log_at = float("-inf")
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
        # Phase 4 Treasury sync: metadata changes are append-only and items are
        # materialized by deterministic last-write-wins. Bodies/attachments are
        # intentionally absent here; their separate on-demand channel can be
        # added without turning every metadata refresh into a private-data dump.
        self.treasury_sync_path = treasury_sync_path or DEFAULT_TREASURY_SYNC_PATH
        self.treasury_items: Dict[str, Dict[str, Any]] = {}
        self.treasury_changes: List[Dict[str, Any]] = []
        self.treasury_change_ids: set[str] = set()
        self.treasury_seen_change_order: List[str] = []
        self.treasury_next_sequence = 1
        self.treasury_updated_at = 0.0
        self.treasury_asset_dir = treasury_asset_dir or os.path.join(
            os.path.dirname(self.treasury_sync_path), "treasury-assets")
        self.treasury_asset_requests: Dict[str, Dict[str, Any]] = {}
        self._load_treasury_sync()

    # -- treasury sync -----------------------------------------------------

    @staticmethod
    def _safe_treasury_text(value: Any, limit: int) -> str:
        return str(value).strip()[:limit] if isinstance(value, str) else ""

    @staticmethod
    def _safe_treasury_time(value: Any) -> float:
        try:
            parsed = float(value)
            return parsed if 0 < parsed < 10_000_000_000 else 0.0
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def _safe_treasury_url(value: Any) -> str:
        if not isinstance(value, str) or len(value) > 16_384:
            return ""
        try:
            parsed = urlsplit(value)
        except ValueError:
            return ""
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            return ""
        if parsed.username or parsed.password:
            return ""
        return value

    def _sanitize_treasury_item(self, raw: Any, device_id: str) -> Optional[Dict[str, Any]]:
        if not isinstance(raw, dict):
            return None
        item_id = self._safe_treasury_text(raw.get("id"), 200)
        kind = self._safe_treasury_text(raw.get("kind"), 20)
        if not item_id or kind not in {
                "link", "text", "note", "image", "document", "audio", "video", "artifact"}:
            return None
        source_uri = self._safe_treasury_url(raw.get("source_uri") or raw.get("url"))
        if kind == "link" and not source_uri:
            return None
        updated_at = self._safe_treasury_time(raw.get("updated_at"))
        created_at = self._safe_treasury_time(raw.get("created_at")) or updated_at
        if not updated_at:
            return None
        tags = raw.get("tags") if isinstance(raw.get("tags"), list) else []
        collections = raw.get("collection_ids") if isinstance(raw.get("collection_ids"), list) else []
        reading_state = self._safe_treasury_text(raw.get("reading_state"), 20)
        if reading_state not in {"none", "unread", "reading", "read"}:
            reading_state = "none"
        processing_state = self._safe_treasury_text(raw.get("processing_state"), 20)
        if processing_state not in {"saved", "queued", "processing", "ready", "partial", "failed"}:
            processing_state = "ready"
        try:
            progress = min(1.0, max(0.0, float(raw.get("reading_progress") or 0)))
        except (TypeError, ValueError):
            progress = 0.0
        digest = self._safe_treasury_text(raw.get("content_digest"), 64).lower()
        if digest and (len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest)):
            digest = ""
        deleted_at = self._safe_treasury_time(raw.get("deleted_at"))
        raw_byte_count = raw.get("byte_count") or 0
        try:
            byte_count = max(0, min(int(raw_byte_count), 2 ** 53 - 1))
        except (TypeError, ValueError, OverflowError):
            byte_count = 0
        return {
            "id": item_id,
            "schema_version": 1,
            "kind": kind,
            "title": self._safe_treasury_text(raw.get("title"), 500),
            "source_uri": source_uri,
            "source_app": self._safe_treasury_text(raw.get("source_app"), 200),
            "source_label": self._safe_treasury_text(raw.get("source_label") or raw.get("source"), 500),
            "summary": self._safe_treasury_text(raw.get("summary"), 4_000),
            "annotation": self._safe_treasury_text(raw.get("annotation"), 20_000),
            "tags": [self._safe_treasury_text(tag, 100) for tag in tags[:100]
                     if self._safe_treasury_text(tag, 100)],
            "collection_ids": [self._safe_treasury_text(entry, 200) for entry in collections[:100]
                               if self._safe_treasury_text(entry, 200)],
            "pinned": raw.get("pinned") is True,
            "archived": raw.get("archived") is True,
            "reading_state": reading_state,
            "reading_progress": progress,
            "created_at": created_at,
            "updated_at": updated_at,
            "last_opened_at": self._safe_treasury_time(raw.get("last_opened_at")),
            "processing_state": processing_state,
            "processing_error_code": self._safe_treasury_text(raw.get("processing_error_code"), 100),
            "content_digest": digest,
            "byte_count": byte_count,
            "mime_type": self._safe_treasury_text(raw.get("mime_type"), 200),
            "body_available": raw.get("body_available") is True,
            "attachment_available": raw.get("attachment_available") is True,
            "origin_device_id": device_id,
            "deleted_at": deleted_at,
        }

    # Fields that describe the stored bytes rather than the shared metadata.
    # Only the device that actually holds those bytes may set them.
    TREASURY_ASSET_OWNED_FIELDS = (
        "kind", "mime_type", "content_digest", "byte_count",
        "body_available", "attachment_available",
    )

    def _materialize_treasury_item(self, item: Dict[str, Any],
                                   device_id: str) -> Dict[str, Any]:
        """Pin byte-describing fields to the device that actually stored them.

        `origin_device_id` on a change means "who produced this change", and
        every client rejects a change whose envelope and item disagree, so it
        has to stay the uploader. But asset requests were routed with that same
        field: pin an item on a second device and the relay started sending its
        attachment requests there, to a device holding only a `remote-<id>`
        placeholder, which answered "unavailable" forever. The bytes' real home
        is tracked separately here, in the materialized item only, so the change
        stream and every existing client stay exactly as they were.

        ponytail: a permanently retired origin device strands its items' bytes;
        recovering that needs an explicit re-share, not an implicit takeover.
        """
        materialized = dict(item)
        current = self.treasury_items.get(item["id"])
        previous = current.get("item") if isinstance(current, dict) else None
        asset_origin = ""
        if isinstance(previous, dict):
            asset_origin = self._safe_treasury_text(
                previous.get("asset_origin_device_id")
                or previous.get("origin_device_id"), 200)
        if not asset_origin or asset_origin == device_id:
            materialized["asset_origin_device_id"] = device_id
            return materialized
        materialized["asset_origin_device_id"] = asset_origin
        for field in self.TREASURY_ASSET_OWNED_FIELDS:
            if field in previous:
                materialized[field] = previous[field]
        return materialized

    @staticmethod
    def _treasury_order_key(change: Dict[str, Any]) -> tuple:
        return (
            float(change.get("updated_at") or 0),
            1 if change.get("operation") == "delete" else 0,
            str(change.get("origin_device_id") or ""),
            str(change.get("change_id") or ""),
        )

    def _load_treasury_sync(self) -> None:
        try:
            with open(self.treasury_sync_path, encoding="utf-8") as stream:
                saved = json.load(stream)
            if not isinstance(saved, dict):
                raise TypeError("invalid treasury state")
            changes = saved.get("changes")
            items = saved.get("items")
            if isinstance(changes, list):
                self.treasury_changes = [entry for entry in changes[-TREASURY_CHANGE_LIMIT:]
                                         if isinstance(entry, dict)]
            seen = saved.get("seen_change_ids")
            if isinstance(seen, list):
                self.treasury_seen_change_order = [str(value) for value in seen[-TREASURY_SEEN_CHANGE_LIMIT:]
                                                   if isinstance(value, str) and value]
            else:
                self.treasury_seen_change_order = [str(entry.get("change_id"))
                                                   for entry in self.treasury_changes if entry.get("change_id")]
            self.treasury_change_ids = set(self.treasury_seen_change_order)
            if isinstance(items, dict):
                self.treasury_items = {
                    str(key): value for key, value in items.items()
                    if isinstance(key, str) and isinstance(value, dict)
                }
            requests = saved.get("asset_requests")
            if isinstance(requests, dict):
                self.treasury_asset_requests = {
                    str(key): value for key, value in requests.items()
                    if self._valid_treasury_asset_request(str(key), value)
                }
            self.treasury_next_sequence = max(
                int(saved.get("next_sequence") or 1),
                1 + max((int(entry.get("sequence") or 0) for entry in self.treasury_changes), default=0),
            )
            self.treasury_updated_at = float(saved.get("updated_at") or 0)
            return
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass

        # One-time compatibility import from the old whole-snapshot mirror.
        legacy_path = os.path.expanduser("~/.leoagent/collections.json")
        try:
            with open(legacy_path, encoding="utf-8") as stream:
                legacy = json.load(stream)
            for index, raw in enumerate(list(legacy.get("items") or [])[:TREASURY_ITEM_LIMIT]):
                updated = self._safe_treasury_time(raw.get("updated_at")) or time.time()
                item = self._sanitize_treasury_item({**raw, "updated_at": updated}, "ios-legacy")
                if item:
                    canonical = json.dumps(item, sort_keys=True, ensure_ascii=False,
                                           separators=(",", ":"))
                    digest = hashlib.sha256(canonical.encode()).hexdigest()
                    self._apply_treasury_change({
                        "change_id": f"legacy-import-{item['id']}-{digest}",
                        "item_id": item["id"], "operation": "upsert",
                        "updated_at": updated, "origin_device_id": "ios-legacy",
                        "payload_digest": digest, "local_sequence": index + 1,
                        "item": item,
                    }, "ios-legacy")
            if self.treasury_items:
                self.treasury_updated_at = float(legacy.get("updated_at") or time.time())
                self._persist_treasury_sync()
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass

    def _persist_treasury_sync(self) -> None:
        directory = os.path.dirname(self.treasury_sync_path)
        if directory:
            os.makedirs(directory, mode=0o700, exist_ok=True)
        tmp = self.treasury_sync_path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump({
                    "version": 1,
                    "next_sequence": self.treasury_next_sequence,
                    "updated_at": self.treasury_updated_at,
                    "changes": self.treasury_changes,
                    "seen_change_ids": self.treasury_seen_change_order,
                    "items": self.treasury_items,
                    "asset_requests": self.treasury_asset_requests,
                }, stream, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, self.treasury_sync_path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def _apply_treasury_change(self, raw: Dict[str, Any], device_id: str) -> tuple[bool, int]:
        change_id = self._safe_treasury_text(raw.get("change_id"), 200)
        item_id = self._safe_treasury_text(raw.get("item_id"), 200)
        operation = self._safe_treasury_text(raw.get("operation"), 20)
        updated_at = self._safe_treasury_time(raw.get("updated_at"))
        digest = self._safe_treasury_text(raw.get("payload_digest"), 64).lower()
        try:
            local_sequence = int(raw.get("local_sequence") or 0)
        except (TypeError, ValueError, OverflowError):
            return False, 0
        if (not change_id or not item_id or operation not in {"upsert", "delete"} or
                not updated_at or local_sequence < 0 or len(digest) != 64 or
                any(ch not in "0123456789abcdef" for ch in digest)):
            return False, 0
        if change_id in self.treasury_change_ids:
            return True, local_sequence
        item = None
        if operation == "upsert":
            item = self._sanitize_treasury_item(raw.get("item"), device_id)
            if not item or item["id"] != item_id:
                return False, 0
        winner = {
            "updated_at": updated_at,
            "operation": operation,
            "origin_device_id": device_id,
            "change_id": change_id,
        }
        sequence = self.treasury_next_sequence
        self.treasury_next_sequence += 1
        change = {
            "sequence": sequence,
            "change_id": change_id,
            "item_id": item_id,
            "operation": operation,
            "updated_at": updated_at,
            "origin_device_id": device_id,
            "payload_digest": digest,
            "item": item,
        }
        self.treasury_changes.append(change)
        self.treasury_change_ids.add(change_id)
        self.treasury_seen_change_order.append(change_id)
        if len(self.treasury_seen_change_order) > TREASURY_SEEN_CHANGE_LIMIT:
            removed_seen = self.treasury_seen_change_order[:-TREASURY_SEEN_CHANGE_LIMIT]
            self.treasury_seen_change_order = self.treasury_seen_change_order[-TREASURY_SEEN_CHANGE_LIMIT:]
            retained_seen = set(self.treasury_seen_change_order)
            self.treasury_change_ids.difference_update(
                change for change in removed_seen if change not in retained_seen)
        current = self.treasury_items.get(item_id)
        if current is None or self._treasury_order_key(winner) > self._treasury_order_key(current["winner"]):
            if operation == "upsert":
                materialized = self._materialize_treasury_item(item, device_id)
            else:
                previous = current.get("item") if isinstance(current, dict) else None
                materialized = {
                    **(previous if isinstance(previous, dict) else {}),
                    "id": item_id, "schema_version": 1,
                    "kind": previous.get("kind", "text") if isinstance(previous, dict) else "text",
                    "title": previous.get("title", "") if isinstance(previous, dict) else "",
                    "source_uri": previous.get("source_uri", "") if isinstance(previous, dict) else "",
                    "source_app": previous.get("source_app", "") if isinstance(previous, dict) else "",
                    "source_label": previous.get("source_label", "同步删除") if isinstance(previous, dict)
                        else "同步删除",
                    "summary": previous.get("summary", "") if isinstance(previous, dict) else "",
                    "annotation": previous.get("annotation", "") if isinstance(previous, dict) else "",
                    "tags": previous.get("tags", []) if isinstance(previous, dict) else [],
                    "collection_ids": previous.get("collection_ids", []) if isinstance(previous, dict) else [],
                    "pinned": previous.get("pinned", False) is True if isinstance(previous, dict) else False,
                    "archived": previous.get("archived", False) is True if isinstance(previous, dict) else False,
                    "reading_state": previous.get("reading_state", "none") if isinstance(previous, dict)
                        else "none",
                    "reading_progress": previous.get("reading_progress", 0) if isinstance(previous, dict) else 0,
                    "created_at": previous.get("created_at", updated_at) if isinstance(previous, dict)
                        else updated_at,
                    "updated_at": updated_at,
                    "last_opened_at": previous.get("last_opened_at", 0) if isinstance(previous, dict) else 0,
                    "processing_state": previous.get("processing_state", "ready") if isinstance(previous, dict)
                        else "ready",
                    "processing_error_code": previous.get("processing_error_code", "")
                        if isinstance(previous, dict) else "",
                    "content_digest": previous.get("content_digest", "") if isinstance(previous, dict) else "",
                    "byte_count": previous.get("byte_count", 0) if isinstance(previous, dict) else 0,
                    "mime_type": previous.get("mime_type", "") if isinstance(previous, dict) else "",
                    "body_available": False, "attachment_available": False,
                    "origin_device_id": device_id, "deleted_at": updated_at,
                }
            self.treasury_items[item_id] = {
                "item": materialized,
                "winner": winner,
                "server_sequence": sequence,
            }
        if len(self.treasury_changes) > TREASURY_CHANGE_LIMIT:
            self.treasury_changes = self.treasury_changes[-TREASURY_CHANGE_LIMIT:]
        self.treasury_updated_at = time.time()
        return True, local_sequence

    def _treasury_asset_path(self, request_id: str) -> str:
        try:
            normalized = str(uuid.UUID(request_id))
        except (ValueError, TypeError, AttributeError):
            return ""
        return os.path.join(self.treasury_asset_dir, normalized + ".bin")

    def _valid_treasury_asset_request(self, request_id: str, value: Any) -> bool:
        if not self._treasury_asset_path(request_id) or not isinstance(value, dict):
            return False
        return (
            self._safe_treasury_text(value.get("item_id"), 200) != ""
            and self._safe_treasury_text(value.get("origin_device_id"), 200) != ""
            and self._safe_treasury_text(value.get("requester_device_id"), 200) != ""
            and value.get("asset_kind") in {"body", "attachment"}
            and value.get("status") in {"pending", "ready", "unavailable"}
        )

    def _clean_treasury_asset_requests(self) -> bool:
        now = time.time()
        expired = [request_id for request_id, value in self.treasury_asset_requests.items()
                   if float(value.get("expires_at") or 0) <= now]
        if not expired:
            return True
        removed = {request_id: self.treasury_asset_requests.pop(request_id)
                   for request_id in expired}
        try:
            self._persist_treasury_sync()
        except OSError:
            self.treasury_asset_requests.update(removed)
            return False
        for request_id in expired:
            asset_path = self._treasury_asset_path(request_id)
            if asset_path:
                try:
                    os.unlink(asset_path)
                except OSError:
                    pass
        return True

    @staticmethod
    def _treasury_mime(value: Any) -> str:
        if not isinstance(value, str):
            return ""
        mime = value.split(";", 1)[0].strip().lower()[:200]
        if not mime or any(ord(ch) < 33 or ord(ch) > 126 for ch in mime):
            return ""
        return mime

    @staticmethod
    def _allowed_treasury_attachment_mime(mime: str) -> bool:
        return mime in {
            "application/json", "application/msword", "application/octet-stream",
            "application/pdf", "application/rtf", "application/vnd.apple.keynote",
            "application/vnd.apple.numbers", "application/vnd.apple.pages",
            "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/xml", "application/zip",
            "audio/aac", "audio/flac", "audio/mp4", "audio/mpeg", "audio/ogg",
            "audio/wav", "audio/x-m4a", "audio/x-wav",
            "image/gif", "image/heic", "image/heif", "image/jpeg", "image/png",
            "image/tiff", "image/webp",
            "text/csv", "text/html", "text/markdown", "text/plain",
            "video/mp4", "video/mpeg", "video/quicktime", "video/webm",
        }

    async def post_treasury_asset_request(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"error": {"message": "invalid json"}}, status=400)
        item_id = self._safe_treasury_text(body.get("item_id"), 200)
        requester = self._safe_treasury_text(body.get("requester_device_id"), 200)
        asset_kind = self._safe_treasury_text(body.get("asset_kind"), 20)
        current = self.treasury_items.get(item_id)
        item = current.get("item") if isinstance(current, dict) else None
        if (not item_id or not requester or asset_kind not in {"body", "attachment"}
                or not isinstance(item, dict) or item.get("deleted_at")):
            return web.json_response({"error": {"message": "treasury item unavailable"}}, status=404)
        available_key = "body_available" if asset_kind == "body" else "attachment_available"
        if item.get(available_key) is not True:
            return web.json_response({"error": {"message": "treasury asset unavailable"}}, status=409)
        origin = self._safe_treasury_text(
            item.get("asset_origin_device_id") or item.get("origin_device_id"), 200)
        if not origin or origin == requester:
            return web.json_response({"error": {"message": "invalid asset request"}}, status=400)
        if not self._clean_treasury_asset_requests():
            return web.json_response({"error": {"message": "treasury persistence failed"}}, status=507)
        for value in self.treasury_asset_requests.values():
            if (value.get("item_id") == item_id and value.get("requester_device_id") == requester
                    and value.get("asset_kind") == asset_kind
                    and value.get("status") in {"pending", "ready"}):
                return web.json_response({"request": value})
        if len(self.treasury_asset_requests) >= TREASURY_ASSET_REQUEST_LIMIT:
            return web.json_response({"error": {"message": "too many asset requests"}}, status=429)
        now = time.time()
        request_id = str(uuid.uuid4())
        value = {
            "id": request_id, "item_id": item_id, "asset_kind": asset_kind,
            "origin_device_id": origin, "requester_device_id": requester,
            "status": "pending", "expected_digest": item.get("content_digest") or "",
            "expected_byte_count": int(item.get("byte_count") or 0),
            "expected_mime_type": self._treasury_mime(item.get("mime_type")),
            "digest": "", "byte_count": 0, "mime_type": "",
            "created_at": now, "updated_at": now, "expires_at": now + TREASURY_ASSET_TTL_S,
        }
        self.treasury_asset_requests[request_id] = value
        try:
            self._persist_treasury_sync()
        except OSError:
            self.treasury_asset_requests.pop(request_id, None)
            return web.json_response({"error": {"message": "treasury persistence failed"}}, status=507)
        return web.json_response({"request": value}, status=201)

    async def get_treasury_asset_requests(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        origin = self._safe_treasury_text(request.query.get("origin_device_id"), 200)
        if not origin:
            return web.json_response({"error": {"message": "origin_device_id is required"}}, status=400)
        if not self._clean_treasury_asset_requests():
            return web.json_response({"error": {"message": "treasury persistence failed"}}, status=507)
        values = [value for value in self.treasury_asset_requests.values()
                  if value.get("origin_device_id") == origin and value.get("status") == "pending"]
        values.sort(key=lambda value: float(value.get("created_at") or 0))
        return web.json_response({"requests": values[:100]})

    async def put_treasury_asset(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        if not self._clean_treasury_asset_requests():
            return web.json_response({"error": {"message": "treasury persistence failed"}}, status=507)
        request_id = str(request.match_info.get("request_id") or "")
        value = self.treasury_asset_requests.get(request_id)
        if not self._valid_treasury_asset_request(request_id, value) or value.get("status") != "pending":
            return web.json_response({"error": {"message": "asset request unavailable"}}, status=404)
        device_id = self._safe_treasury_text(request.headers.get("X-Treasury-Device-ID"), 200)
        digest_header = self._safe_treasury_text(request.headers.get("X-Treasury-Digest"), 64).lower()
        mime_type = self._treasury_mime(request.headers.get("Content-Type"))
        try:
            declared_count = int(request.headers.get("X-Treasury-Byte-Count", "-1"))
        except (TypeError, ValueError, OverflowError):
            declared_count = -1
        if (device_id != value.get("origin_device_id") or len(digest_header) != 64
                or any(ch not in "0123456789abcdef" for ch in digest_header)
                or not mime_type or declared_count < 0):
            return web.json_response({"error": {"message": "invalid asset metadata"}}, status=400)
        asset_kind = value.get("asset_kind")
        limit = TREASURY_BODY_LIMIT if asset_kind == "body" else TREASURY_ATTACHMENT_LIMIT
        if declared_count > limit:
            return web.json_response({"error": {"message": "asset too large"}}, status=413)
        if asset_kind == "body" and mime_type != "text/plain":
            return web.json_response({"error": {"message": "invalid body mime type"}}, status=415)
        if asset_kind == "attachment" and not self._allowed_treasury_attachment_mime(mime_type):
            return web.json_response({"error": {"message": "unsupported attachment mime type"}}, status=415)
        expected_count = int(value.get("expected_byte_count") or 0)
        expected_digest = str(value.get("expected_digest") or "").lower()
        expected_mime = str(value.get("expected_mime_type") or "").lower()
        if asset_kind == "attachment" and expected_count > 0 and declared_count != expected_count:
            return web.json_response({"error": {"message": "asset byte count mismatch"}}, status=409)
        if asset_kind == "attachment" and expected_digest and digest_header != expected_digest:
            return web.json_response({"error": {"message": "asset digest mismatch"}}, status=409)
        if (asset_kind == "attachment" and expected_mime and
                expected_mime != "application/octet-stream" and mime_type != expected_mime):
            return web.json_response({"error": {"message": "asset mime type mismatch"}}, status=409)
        os.makedirs(self.treasury_asset_dir, mode=0o700, exist_ok=True)
        target = self._treasury_asset_path(request_id)
        temporary = target + ".tmp"
        actual_digest = hashlib.sha256()
        actual_count = 0
        try:
            stream = open(temporary, "wb")
            os.chmod(temporary, 0o600)
            try:
                async for chunk in request.content.iter_chunked(1024 * 1024):
                    actual_count += len(chunk)
                    if actual_count > limit or actual_count > declared_count:
                        raise ValueError("asset too large")
                    actual_digest.update(chunk)
                    await asyncio.to_thread(stream.write, chunk)
                await asyncio.to_thread(stream.flush)
                await asyncio.to_thread(os.fsync, stream.fileno())
            finally:
                stream.close()
            if actual_count != declared_count or actual_digest.hexdigest() != digest_header:
                raise ValueError("asset integrity mismatch")
            if asset_kind == "body":
                with open(temporary, "rb") as body_stream:
                    body_stream.read().decode("utf-8")
            os.replace(temporary, target)
        except (OSError, ValueError, UnicodeDecodeError):
            try:
                os.unlink(temporary)
            except OSError:
                pass
            return web.json_response({"error": {"message": "asset integrity validation failed"}}, status=422)
        previous_value = dict(value)
        value.update({
            "status": "ready", "digest": digest_header, "byte_count": actual_count,
            "mime_type": mime_type, "updated_at": time.time(),
            "expires_at": time.time() + TREASURY_ASSET_TTL_S,
        })
        try:
            self._persist_treasury_sync()
        except OSError:
            value.clear()
            value.update(previous_value)
            try:
                os.unlink(target)
            except OSError:
                pass
            return web.json_response({"error": {"message": "treasury persistence failed"}}, status=507)
        return web.json_response({"request": value})

    async def post_treasury_asset_unavailable(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        if not self._clean_treasury_asset_requests():
            return web.json_response({"error": {"message": "treasury persistence failed"}}, status=507)
        request_id = str(request.match_info.get("request_id") or "")
        value = self.treasury_asset_requests.get(request_id)
        if not self._valid_treasury_asset_request(request_id, value) or value.get("status") != "pending":
            return web.json_response({"error": {"message": "asset request unavailable"}}, status=404)
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        device_id = self._safe_treasury_text(body.get("device_id"), 200)
        if device_id != value.get("origin_device_id"):
            return web.json_response({"error": {"message": "asset request denied"}}, status=403)
        previous_value = dict(value)
        value.update({"status": "unavailable", "updated_at": time.time(),
                      "expires_at": time.time() + TREASURY_ASSET_TTL_S})
        try:
            self._persist_treasury_sync()
        except OSError:
            value.clear()
            value.update(previous_value)
            return web.json_response({"error": {"message": "treasury persistence failed"}}, status=507)
        return web.json_response({"request": value})

    async def get_treasury_asset(self, request: web.Request) -> web.StreamResponse:
        if not self._authorized(request):
            return self._unauthorized()
        if not self._clean_treasury_asset_requests():
            return web.json_response({"error": {"message": "treasury persistence failed"}}, status=507)
        request_id = str(request.match_info.get("request_id") or "")
        value = self.treasury_asset_requests.get(request_id)
        requester = self._safe_treasury_text(request.headers.get("X-Treasury-Device-ID"), 200)
        if not self._valid_treasury_asset_request(request_id, value) \
                or requester != value.get("requester_device_id"):
            return web.json_response({"error": {"message": "asset request unavailable"}}, status=404)
        if value.get("status") == "pending":
            return web.json_response({"request": value}, status=202)
        if value.get("status") != "ready":
            return web.json_response({"request": value}, status=410)
        asset_path = self._treasury_asset_path(request_id)
        if not asset_path or not os.path.isfile(asset_path):
            return web.json_response({"error": {"message": "asset file unavailable"}}, status=410)
        response = web.FileResponse(asset_path, headers={
            "Content-Type": str(value.get("mime_type") or "application/octet-stream"),
            "X-Treasury-Digest": str(value.get("digest") or ""),
            "X-Treasury-Byte-Count": str(int(value.get("byte_count") or 0)),
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, no-store",
        })
        return response

    # -- auth ---------------------------------------------------------------

    @staticmethod
    def _hash_key(key: str) -> str:
        return hashlib.sha256(key.encode("utf-8")).hexdigest()

    @staticmethod
    def _presented_key(header: str) -> str:
        if not header.startswith("Bearer "):
            return ""
        # 清洗复制残渣:从终端复制密钥时常带上 zsh 的行尾标记 % 或换行。
        # 我们生成的密钥不含这些字符,尾部剥掉是安全的。
        return header[7:].strip().rstrip("%").strip()

    def _master_valid(self, now: float) -> bool:
        return self.master_expires_at is None or now < self.master_expires_at

    def _caller_from_key(self, presented: str) -> Optional[Caller]:
        if not presented:
            return None
        now = time.time()
        try:
            if self._master_valid(now) and any(hmac.compare_digest(presented, k) for k in self.keys):
                return Caller("master")
        except (TypeError, ValueError):
            return None
        digest = self._hash_key(presented)
        if self.register_key_hash and hmac.compare_digest(digest, self.register_key_hash):
            return Caller("register")
        device_id = self.device_by_hash.get(digest)
        if device_id:
            device = self.devices.get(device_id)
            if device and float(device.get("expires_at") or 0) > now:
                self._touch_device(device_id, now)
                return Caller(str(device.get("kind") or "legacy"), device_id=device_id,
                              name=str(device.get("name") or ""))
        for machine, pin_hash in self.pins.items():
            if hmac.compare_digest(digest, pin_hash):
                return Caller("machine", machine=machine)
        return None

    def _caller(self, request: web.Request) -> Optional[Caller]:
        return self._caller_from_key(self._presented_key(request.headers.get("Authorization", "")))

    def _authorized(self, request: web.Request) -> bool:
        """客户端接口:主钥匙(宽限期内)、iPhone / 旧版设备钥匙。"""
        presented = self._presented_key(request.headers.get("Authorization", ""))
        if not presented:
            return False
        caller = self._caller_from_key(presented)
        if caller is not None and caller.is_client:
            return True
        if caller is None:
            self._record_rejected(presented, request.path)
        return False

    def _admin(self, request: web.Request) -> Optional[Caller]:
        caller = self._caller(request)
        return caller if caller is not None and caller.is_admin else None

    # -- 身份状态 -------------------------------------------------------------

    def _load_state(self) -> None:
        try:
            with open(self.state_path, encoding="utf-8") as f:
                saved = json.load(f)
        except (OSError, json.JSONDecodeError):
            saved = {}
        if isinstance(saved, dict):
            devices = saved.get("devices")
            if isinstance(devices, dict):
                self.devices = {str(k): v for k, v in devices.items()
                                if isinstance(v, dict) and isinstance(v.get("key_hash"), str)}
            pins = saved.get("pins")
            if isinstance(pins, dict):
                self.pins = {str(k): str(v) for k, v in pins.items() if isinstance(v, str)}
            register = saved.get("register_key_hash")
            self.register_key_hash = register if isinstance(register, str) and register else None
            expires = saved.get("master_expires_at")
            self.master_expires_at = float(expires) if isinstance(expires, (int, float)) else None
        self._migrate_device_keys_v01()
        self._reindex_devices()

    def _migrate_device_keys_v01(self) -> None:
        """0.1 的 device-keys.json(明文钥匙 → 到期时间)迁成旧版设备,只留哈希。"""
        path = self.device_keys_path
        try:
            with open(path, encoding="utf-8") as f:
                saved = json.load(f)
        except (OSError, json.JSONDecodeError):
            return
        rows = saved.get("keys") if isinstance(saved, dict) else None
        if not isinstance(rows, dict):
            return
        now = time.time()
        known = {d.get("key_hash") for d in self.devices.values()}
        n = 0
        for key, exp in rows.items():
            try:
                expires = float(exp)
            except (TypeError, ValueError):
                continue
            if not isinstance(key, str) or len(key) < 16 or expires <= now:
                continue
            digest = self._hash_key(key)
            if digest in known:
                continue
            n += 1
            device_id = uuid.uuid4().hex[:16]
            self.devices[device_id] = {
                "name": f"旧版设备 {n}", "kind": "legacy", "key_hash": digest,
                "created_at": now, "last_seen": 0.0,
                "expires_at": max(expires, now + DEVICE_KEY_TTL_S), "push": None,
            }
            known.add(digest)
        self._save_state()
        try:
            migrated = path + ".migrated-0.2"
            os.replace(path, migrated)
            os.chmod(migrated, 0o600)
        except OSError:
            pass

    def _reindex_devices(self) -> None:
        self.device_by_hash = {str(d["key_hash"]): device_id for device_id, d in self.devices.items()}

    def _save_state(self) -> None:
        directory = os.path.dirname(self.state_path)
        try:
            os.makedirs(directory, mode=0o700, exist_ok=True)
            tmp = self.state_path + ".tmp"
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({
                    "version": 2,
                    "devices": self.devices,
                    "pins": self.pins,
                    "register_key_hash": self.register_key_hash,
                    "master_expires_at": self.master_expires_at,
                }, f)
            os.replace(tmp, self.state_path)
            os.chmod(self.state_path, 0o600)
        except OSError:
            pass

    def _touch_device(self, device_id: str, now: float) -> None:
        device = self.devices.get(device_id)
        if device is None:
            return
        device["last_seen"] = now
        device["expires_at"] = now + DEVICE_KEY_TTL_S
        # 滑动续期只在内存里改;最多一小时落一次盘,别让每个请求都写文件。
        if now - self._last_touch_persist > 3600:
            self._last_touch_persist = now
            self._save_state()

    def _create_device(self, name: str, kind: str) -> tuple:
        key = secrets.token_urlsafe(32)
        device_id = uuid.uuid4().hex[:16]
        now = time.time()
        self.devices[device_id] = {
            "name": (name or ("iPhone" if kind == "iphone" else "旧版设备"))[:60],
            "kind": kind, "key_hash": self._hash_key(key),
            "created_at": now, "last_seen": now,
            "expires_at": now + DEVICE_KEY_TTL_S, "push": None,
        }
        self._reindex_devices()
        self._save_state()
        return key, device_id

    def _record_rejected(self, presented: str, path: str) -> None:
        if not self.rejected_log or not presented:
            return
        now = time.monotonic()
        if now - self._last_rejected_log_at < 1.0:
            return
        self._last_rejected_log_at = now
        try:
            fingerprint = hmac.new(
                self.key.encode("utf-8"), presented.encode("utf-8"), hashlib.sha256
            ).hexdigest()[:16]
            safe_path = path.replace("\n", "").replace("\r", "")[:160]
            line = f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {safe_path} hmac={fingerprint}\n"
            if os.path.exists(self.rejected_log) and os.path.getsize(self.rejected_log) >= 64 * 1024:
                backup = self.rejected_log + ".1"
                try:
                    os.unlink(backup)
                except FileNotFoundError:
                    pass
                os.replace(self.rejected_log, backup)
            fd = os.open(self.rejected_log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a") as f:
                f.write(line)
        except OSError:
            pass

    def _purge_join_tokens(self) -> None:
        now = time.time()
        stale = [token for token, rec in self.join_tokens.items() if rec.get("exp", 0) < now]
        for token in stale:
            self.join_tokens.pop(token, None)
        # 待定的配对:过期一小时后清掉(过期后手机轮询会看到 expired)。
        dead = [pid for pid, rec in self.pending_joins.items() if rec.get("exp", 0) + 3600 < now]
        for pid in dead:
            self.pending_joins.pop(pid, None)

    @staticmethod
    def _unauthorized() -> web.Response:
        return web.json_response(
            {"error": {"message": "Invalid relay key", "code": "relay_auth_failed"}},
            status=401,
        )

    @staticmethod
    def _source(request: web.Request) -> str:
        forwarded = request.headers.get("X-Forwarded-For", "")
        first = forwarded.split(",")[0].strip()
        return first or (getattr(request, "remote", None) or "?")

    def _join_locked(self, source: str) -> bool:
        now = time.time()
        recent = [t for t in self.join_failures.get(source, []) if now - t < JOIN_FAIL_WINDOW_S]
        if recent:
            self.join_failures[source] = recent
        else:
            self.join_failures.pop(source, None)
        return len(recent) >= JOIN_FAIL_LIMIT

    def _note_join_failure(self, source: str) -> None:
        self.join_failures.setdefault(source, []).append(time.time())

    @staticmethod
    async def _json_body(request: web.Request) -> Dict[str, Any]:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return {}
        return body if isinstance(body, dict) else {}

    async def create_join_token(self, request: web.Request) -> web.Response:
        """Mac(机器专属钥匙)或主钥匙签发一次性码。设备钥匙不能签发。

        kind=iphone:兑换后待定,Mac 点允许才发钥匙(Mac 1.2 出的码默认如此)。
        kind=legacy:兑换即发旧版设备钥匙,给 Android / 鸿蒙(主钥匙调用时默认,与 0.1 一致)。
        """
        caller = self._admin(request)
        if caller is None:
            return self._unauthorized()
        body = await self._json_body(request)
        machine = str(body.get("machine") or caller.machine or "").strip()
        default_kind = "iphone" if caller.kind == "machine" else "legacy"
        kind = str(body.get("kind") or default_kind)
        if kind not in ("iphone", "legacy"):
            kind = default_kind
        self._purge_join_tokens()
        token = secrets.token_urlsafe(16)
        exp = time.time() + JOIN_TTL_S
        self.join_tokens[token] = {"machine": machine, "kind": kind, "exp": exp}
        return web.json_response({"token": token, "exp": exp, "machine": machine, "kind": kind})

    async def delete_join_token(self, request: web.Request) -> web.Response:
        """Mac 关掉出码页时作废这个码。"""
        if self._admin(request) is None:
            return self._unauthorized()
        self.join_tokens.pop(request.match_info["token"], None)
        return web.json_response({"ok": True})

    async def join(self, request: web.Request) -> web.Response:
        """用一次性码配对。旧式码立即发钥匙;iPhone 码进入待定,等 Mac 点允许。"""
        source = self._source(request)
        if self._join_locked(source):
            return web.json_response(
                {"error": {"message": "尝试太频繁,请一分钟后再试"}}, status=429)
        body = await self._json_body(request)
        token = str(body.get("token") or "").strip()
        self._purge_join_tokens()
        rec = self.join_tokens.pop(token, None)
        if not rec or rec.get("exp", 0) < time.time():
            self._note_join_failure(source)
            return web.json_response(
                {"error": {"message": "join token expired or unknown"}}, status=409,
            )
        machine = str(rec.get("machine") or "")
        name = str(body.get("name") or "").strip()[:60]
        if rec.get("kind") == "iphone":
            now = time.time()
            pending_id = uuid.uuid4().hex
            secret = secrets.token_urlsafe(24)
            self.pending_joins[pending_id] = {
                "id": pending_id, "name": name or "iPhone", "machine": machine,
                "secret_hash": self._hash_key(secret), "created_at": now,
                "exp": now + JOIN_TTL_S, "status": "pending",
            }
            return web.json_response({
                "status": "pending", "pendingId": pending_id, "pollSecret": secret,
                "machine": machine,
            }, status=202)
        access_key, device_id = self._create_device(name or "旧版设备", "legacy")
        return web.json_response({"accessKey": access_key, "machine": machine, "deviceId": device_id})

    async def join_status(self, request: web.Request) -> web.Response:
        """手机轮询待定的配对。批准后只交付一次钥匙。"""
        pending_id = request.match_info["pending_id"]
        secret = request.query.get("secret", "")
        rec = self.pending_joins.get(pending_id)
        if rec is None or not secret or not hmac.compare_digest(self._hash_key(secret), rec["secret_hash"]):
            return web.json_response({"error": {"message": "unknown pairing request"}}, status=404)
        if rec["status"] == "pending" and rec["exp"] < time.time():
            rec["status"] = "expired"
        if rec["status"] == "approved":
            self.pending_joins.pop(pending_id, None)
            return web.json_response({
                "status": "approved", "accessKey": rec.get("access_key"),
                "deviceId": rec.get("device_id"), "machine": rec.get("machine"),
            })
        return web.json_response({"status": rec["status"]})

    async def list_join_requests(self, request: web.Request) -> web.Response:
        if self._admin(request) is None:
            return self._unauthorized()
        self._purge_join_tokens()
        now = time.time()
        pending = [
            {"id": r["id"], "name": r["name"], "machine": r["machine"], "created_at": r["created_at"]}
            for r in self.pending_joins.values() if r["status"] == "pending" and r["exp"] >= now
        ]
        return web.json_response({"requests": pending})

    async def decide_join_request(self, request: web.Request) -> web.Response:
        if self._admin(request) is None:
            return self._unauthorized()
        rec = self.pending_joins.get(request.match_info["pending_id"])
        if rec is None or rec["status"] != "pending" or rec["exp"] < time.time():
            return web.json_response({"error": {"message": "配对请求已过期或不存在"}}, status=404)
        body = await self._json_body(request)
        if str(body.get("decision") or "") == "allow":
            access_key, device_id = self._create_device(rec["name"], "iphone")
            rec.update({"status": "approved", "access_key": access_key, "device_id": device_id})
            return web.json_response({"ok": True, "deviceId": device_id})
        rec["status"] = "denied"
        return web.json_response({"ok": True})

    async def device_exchange(self, request: web.Request) -> web.Response:
        """iOS 1.40 起首启:用旧主钥匙换一把自己的设备钥匙(只在主钥匙有效期内可用)。"""
        caller = self._caller(request)
        if caller is None or caller.kind != "master":
            return self._unauthorized()
        body = await self._json_body(request)
        access_key, device_id = self._create_device(str(body.get("name") or "iPhone"), "iphone")
        return web.json_response({"accessKey": access_key, "deviceId": device_id})

    async def list_devices(self, request: web.Request) -> web.Response:
        if self._admin(request) is None:
            return self._unauthorized()
        return web.json_response({"devices": [
            {"id": device_id, "name": d.get("name"), "kind": d.get("kind"),
             "created_at": d.get("created_at"), "last_seen": d.get("last_seen"),
             "has_push": bool(d.get("push"))}
            for device_id, d in sorted(self.devices.items(), key=lambda kv: -(kv[1].get("last_seen") or 0))
        ]})

    async def revoke_device(self, request: web.Request) -> web.Response:
        """撤销一台设备:钥匙立即失效,推送 token 一并删除。"""
        if self._admin(request) is None:
            return self._unauthorized()
        device = self.devices.pop(request.match_info["device_id"], None)
        if device is None:
            return web.json_response({"error": {"message": "unknown device"}}, status=404)
        push = device.get("push")
        if isinstance(push, dict) and push.get("token"):
            forget = getattr(self.apns, "_forget", None)
            if callable(forget):
                try:
                    forget(str(push.get("kind") or "device"), str(push.get("token")))
                except Exception:  # noqa: BLE001
                    pass
        self._reindex_devices()
        self._save_state()
        return web.json_response({"ok": True})

    async def rotate_keys(self, request: web.Request) -> web.Response:
        """主钥匙轮换:生成 Mac 注册钥匙(只返回这一次),旧主钥匙再有效 grace_days 天。"""
        caller = self._caller(request)
        if caller is None or caller.kind != "master":
            return self._unauthorized()
        body = await self._json_body(request)
        try:
            grace_days = max(0.0, float(body.get("grace_days", MASTER_GRACE_S / 86400)))
        except (TypeError, ValueError):
            grace_days = MASTER_GRACE_S / 86400
        register_key = secrets.token_urlsafe(32)
        self.register_key_hash = self._hash_key(register_key)
        self.master_expires_at = time.time() + grace_days * 86400
        self._save_state()
        return web.json_response({"registerKey": register_key, "masterExpiresAt": self.master_expires_at})

    async def unpin_machine(self, request: web.Request) -> web.Response:
        """解除机器名钉扎(回滚时用):只认这台机器自己的专属钥匙或主钥匙。"""
        caller = self._caller(request)
        name = request.match_info["name"]
        if caller is None or not (caller.kind == "master" or (caller.kind == "machine" and caller.machine == name)):
            return self._unauthorized()
        self.pins.pop(name, None)
        self._save_state()
        return web.json_response({"ok": True})

    async def queue_status(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        request_id = request.match_info["request_id"]
        result = self.queue_results.get(request_id)
        if result is not None:
            return web.json_response(result)
        for items in self.offline_queue.values():
            if any(item["request_id"] == request_id for item in items):
                return web.json_response({"status": "queued"})
        return web.json_response({"status": "unknown"}, status=404)

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
                    name = str(frame.get("name") or "mac")
                    caller = self._caller_from_key(str(frame.get("key") or "").strip())
                    pinned = name in self.pins
                    if pinned:
                        # 钉扎过的名字只认这台机器自己的专属钥匙:别人拿主钥匙也顶不掉它。
                        if caller is None or caller.kind != "machine" or caller.machine != name:
                            await ws.close(code=4003, message=b"name pinned")
                            break
                    elif caller is None or caller.kind not in ("master", "register", "legacy"):
                        await ws.close(code=4001, message=b"bad key")
                        break
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
                    ack: Dict[str, Any] = {"type": "registered", "version": VERSION}
                    if not pinned and frame.get("pin") is True and caller.kind in ("master", "register"):
                        machine_key = secrets.token_urlsafe(32)
                        self.pins[name] = self._hash_key(machine_key)
                        self._save_state()
                        ack["machine_key"] = machine_key
                    await ws.send_json(ack)
                    if self.offline_queue.get(name):
                        task = asyncio.get_running_loop().create_task(self._flush_queue(machine))
                        self._bg_tasks.add(task)
                        task.add_done_callback(self._bg_tasks.discard)

                elif machine is None:
                    continue  # 未注册前只认 register

                elif kind == "resp":
                    fut = machine.pending.pop(str(frame.get("id")), None)
                    if fut is not None and not fut.done():
                        fut.set_result(frame)

                elif kind == "stream_keepalive":
                    # Mac 转过来的 SSE 注释帧。它只为保活,丢一两个无所谓,
                    # 绝不能因为它把队列挤满而触发下面的"慢消费者关流"。
                    queue = machine.streams.get(str(frame.get("id")))
                    if queue is not None:
                        try:
                            queue.put_nowait(frame)
                        except asyncio.QueueFull:
                            pass

                elif kind in ("stream_data", "stream_close"):
                    queue = machine.streams.get(str(frame.get("id")))
                    if queue is not None:
                        try:
                            queue.put_nowait(frame)
                        except asyncio.QueueFull:
                            # 手机端读得慢。绝不能让 QueueFull 冲出消息循环
                            # ——那会注销整台 Mac 的中继连接;但静默丢帧会给
                            # live 流留下 seq 空洞且对端毫无感知。清空队列改塞
                            # stream_close,让手机立刻走重连 + replay 补齐
                            # (与 harness 端慢订阅者哨兵同一策略)。
                            # 必须整队清掉:只挤掉队首一帧的话,后面的帧照发,手机
                            # 的续传游标越过被挤掉的那条,它就再也补不回来了。队列
                            # 里的帧都还没到手机,游标停在它们之前,replay 一条不少。
                            while not queue.empty():
                                queue.get_nowait()
                            queue.put_nowait({"type": "stream_close",
                                              "id": frame.get("id"),
                                              "reason": "slow consumer"})
                        # 已缓冲的一大批帧(比如接管长会话时的整段回放)这个循环会一口气
                        # 读完、不让出事件循环,转发协程插不上手,好好的手机也会被挤爆。
                        # 过半就让一下,让它先把队列清掉。
                        if queue.qsize() >= queue.maxsize // 2:
                            await asyncio.sleep(0)

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
                    try:
                        queue.put_nowait({"type": "stream_close", "reason": "machine disconnected"})
                    except asyncio.QueueFull:
                        pass  # 满 = 消费端已死,close 帧丢了也会随连接一起清
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
                        "sent_at": time.time(),
                        "machine": machine_name,
                        "harnessSessionId": str(event.get("session_id") or ""),
                        "approvalId": str(event.get("approval_id") or ""),
                    },
                    category="HARNESS_APPROVAL",
                    time_sensitive=True,
                    # 审批按 approval_id 折叠而不是按会话:同会话并发两条
                    # 待审批时,第二条横幅不能把第一条顶掉(各自独立可答);
                    # outbox 补发的同一条审批依然被折叠。
                    collapse_id=f"{kind}-{event.get('approval_id') or event.get('session_id', '')}",
                )
            # run.failed 故意不推:错误在 app 里、实时活动上都看得到,计划定的是"错误不推送"。
            # 事件本身照样进 recent_events,手机回前台拉 /relay/api/events 仍能补齐。
            elif kind == "run.completed":
                await self.apns.send_alert(
                    title=f"✅ {machine_name} 任务完成",
                    body=str(event.get("output") or "任务已结束")[:200],
                    user_info={"harnessSessionId": str(event.get("session_id") or ""),
                               "sent_at": time.time()},
                
                    collapse_id=f"{kind}-{event.get('session_id', '')}",
                )
        except Exception as exc:  # noqa: BLE001
            print(f"[relay] apns push failed: {exc}", flush=True)

    async def put_collections(self, request: web.Request) -> web.Response:
        """Compatibility adapter for clients that still send a whole snapshot.

        The relay no longer truncates to 500 or replaces another device's data.
        Each legacy item becomes an idempotent metadata change; missing ids from
        that same legacy device become tombstones.
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
        if len(items) > TREASURY_ITEM_LIMIT:
            return web.json_response({"error": {"message": "too many items"}}, status=413)
        device_id = self._safe_treasury_text(body.get("device_id"), 200) or "ios-legacy"
        seen: set[str] = set()
        accepted = 0
        now = time.time()
        for index, raw in enumerate(items):
            if not isinstance(raw, dict):
                continue
            item_id = self._safe_treasury_text(raw.get("id"), 200)
            updated = self._safe_treasury_time(raw.get("updated_at")) or now
            canonical = json.dumps(raw, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            change = {
                "change_id": f"legacy-{device_id}-{item_id}-{hashlib.sha256(canonical.encode()).hexdigest()}",
                "item_id": item_id,
                "operation": "upsert",
                "updated_at": updated,
                "origin_device_id": device_id,
                "payload_digest": hashlib.sha256(canonical.encode()).hexdigest(),
                "local_sequence": index + 1,
                "item": {**raw, "updated_at": updated},
            }
            ok, _ = self._apply_treasury_change(change, device_id)
            if ok:
                accepted += 1
                seen.add(item_id)
        for item_id, current in list(self.treasury_items.items()):
            winner = current.get("winner") or {}
            if winner.get("origin_device_id") != device_id or item_id in seen:
                continue
            digest = hashlib.sha256(f"legacy-delete:{device_id}:{item_id}:{now}".encode()).hexdigest()
            self._apply_treasury_change({
                "change_id": f"legacy-delete-{device_id}-{item_id}-{int(now * 1000)}",
                "item_id": item_id, "operation": "delete", "updated_at": now,
                "origin_device_id": device_id, "payload_digest": digest, "local_sequence": 0,
            }, device_id)
        try:
            self._persist_treasury_sync()
        except OSError:
            return web.json_response({"error": {"message": "treasury persistence failed"}}, status=507)
        return web.json_response({"ok": True, "count": accepted,
                                  "cursor": self.treasury_next_sequence - 1})

    async def get_collections(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        items = [entry["item"] for entry in self.treasury_items.values()
                 if not entry["item"].get("deleted_at")]
        items.sort(key=lambda item: float(item.get("updated_at") or 0), reverse=True)
        return web.json_response({
            "items": items,
            "updated_at": self.treasury_updated_at,
            "cursor": self.treasury_next_sequence - 1,
        })

    async def post_treasury_changes(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"error": {"message": "invalid json"}}, status=400)
        device_id = self._safe_treasury_text(body.get("device_id"), 200)
        changes = body.get("changes")
        if not device_id or not isinstance(changes, list):
            return web.json_response({"error": {"message": "device_id and changes are required"}}, status=400)
        if len(changes) > TREASURY_BATCH_LIMIT:
            return web.json_response({"error": {"message": "change batch too large"}}, status=413)
        accepted = 0
        ack_local_cursor = 0
        previous_local_sequence = -1
        for raw in changes:
            if not isinstance(raw, dict):
                break
            try:
                local_sequence = int(raw.get("local_sequence") or 0)
            except (TypeError, ValueError, OverflowError):
                break
            # The acknowledgement is a contiguous upload cursor. Continuing
            # past a malformed or out-of-order row could acknowledge a later
            # local sequence and permanently skip the bad row on the client.
            if local_sequence < 0 or local_sequence <= previous_local_sequence:
                break
            ok, local_sequence = self._apply_treasury_change(raw, device_id)
            if not ok:
                break
            previous_local_sequence = local_sequence
            accepted += 1
            ack_local_cursor = local_sequence
        try:
            if accepted:
                self._persist_treasury_sync()
        except OSError:
            return web.json_response({"error": {"message": "treasury persistence failed"}}, status=507)
        return web.json_response({
            "accepted": accepted,
            "ack_local_cursor": ack_local_cursor,
            "next_cursor": self.treasury_next_sequence - 1,
        })

    async def get_treasury_changes(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        try:
            after = max(0, int(request.query.get("after", "0")))
            limit = max(1, min(TREASURY_BATCH_LIMIT, int(request.query.get("limit", "500"))))
        except (TypeError, ValueError):
            return web.json_response({"error": {"message": "invalid cursor"}}, status=400)
        min_cursor = int(self.treasury_changes[0]["sequence"]) - 1 if self.treasury_changes else 0
        if after < min_cursor:
            return web.json_response({"error": {"message": "cursor expired"},
                                      "min_cursor": min_cursor}, status=410)
        page = [entry for entry in self.treasury_changes if int(entry["sequence"]) > after][:limit]
        next_cursor = int(page[-1]["sequence"]) if page else after
        # A change can be accepted into the append-only log but lose the
        # deterministic LWW materialization. Marking winners explicitly lets
        # clients advance their cursors without briefly applying stale rows or
        # needing to persist the relay's private tie-break metadata locally.
        delivered = []
        for entry in page:
            current = self.treasury_items.get(str(entry.get("item_id") or ""))
            winner = current.get("winner") if isinstance(current, dict) else None
            delivered.append({
                **entry,
                "applied": isinstance(winner, dict)
                and winner.get("change_id") == entry.get("change_id"),
            })
        return web.json_response({
            "changes": delivered,
            "next_cursor": next_cursor,
            "has_more": any(int(entry["sequence"]) > next_cursor for entry in self.treasury_changes),
            "min_cursor": min_cursor,
            "server_cursor": self.treasury_next_sequence - 1,
            "updated_at": self.treasury_updated_at,
        })

    async def get_treasury_items(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return self._unauthorized()
        try:
            after = max(0, int(request.query.get("after_sequence", "0")))
            limit = max(1, min(1_000, int(request.query.get("limit", "1000"))))
        except (TypeError, ValueError):
            return web.json_response({"error": {"message": "invalid cursor"}}, status=400)
        materialized = sorted(self.treasury_items.values(), key=lambda entry: int(entry["server_sequence"]))
        page = [entry for entry in materialized if int(entry["server_sequence"]) > after][:limit]
        next_cursor = int(page[-1]["server_sequence"]) if page else after
        return web.json_response({
            "items": [{**entry["item"], "server_sequence": entry["server_sequence"]} for entry in page],
            "next_cursor": next_cursor,
            "has_more": any(int(entry["server_sequence"]) > next_cursor for entry in materialized),
            "server_cursor": self.treasury_next_sequence - 1,
            "updated_at": self.treasury_updated_at,
        })

    async def register_device(self, request: web.Request) -> web.Response:
        """手机登记推送 token。kind ∈ {device, push_to_start}。

        设备钥匙调用时,token 记在这台设备名下:撤销设备就一并删掉它的推送。
        """
        caller = self._caller(request)
        if caller is None or not caller.is_client:
            return self._unauthorized()
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"error": {"message": "invalid json"}}, status=400)
        if caller.device_id and caller.device_id in self.devices:
            self.devices[caller.device_id]["push"] = {
                "kind": str(body.get("kind") or "device"), "token": str(body.get("token") or ""),
            }
            self._save_state()
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
        # info 是**注册方**给的,必须先展开、再由中继的权威字段覆盖它。
        # 反过来写(固定字段在前)的话,一台机器只要在 info 里带个 name,
        # 列表里显示的名字就和真正的路由 key 不一致 —— 配对码里塞的是那个
        # 假名字,手机拿着它去 /m/{name}/... 永远路由不到。
        return web.json_response({"machines": [
            {**m.info, "name": m.name, "online": True, "connected_at": m.connected_at}
            for m in self.machines.values()
        ]})

    @staticmethod
    def _queueable(method: str, tail: str) -> bool:
        """只有建任务和发送可以排队;其余请求离线就是离线。"""
        if method != "POST":
            return False
        path = tail.split("?", 1)[0].rstrip("/")
        if path == "/harness/sessions":
            return True
        parts = path.split("/")
        return len(parts) == 5 and parts[1] == "harness" and parts[2] == "sessions" and parts[4] == "send"

    async def forward(self, request: web.Request) -> web.StreamResponse:
        caller = self._caller(request)
        if caller is None or not caller.is_client:
            if caller is None:
                self._record_rejected(self._presented_key(request.headers.get("Authorization", "")),
                                      request.path)
            return self._unauthorized()
        name = request.match_info["name"]
        machine = self.machines.get(name)
        tail = "/" + request.match_info["tail"]
        query = request.query_string
        if query:
            tail = f"{tail}?{query}"
        if machine is None:
            if request.headers.get("X-Leo-Queue") == "1" and self._queueable(request.method, tail):
                return await self._enqueue(request, name, tail, caller)
            return web.json_response(
                {"error": {"message": "这台 Mac 当前不在线(它会自动重连,稍后再试)"}},
                status=502,
            )

        # 事件流:逐帧转发,其余:一问一答
        if request.method == "GET" and "/events" in tail:
            return await self._forward_stream(request, machine, tail, caller)

        body: Optional[Any] = None
        if request.method in ("POST", "PUT"):
            try:
                body = await request.json()
            except Exception:  # noqa: BLE001
                body = None
        request_id = uuid.uuid4().hex
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        machine.pending[request_id] = fut
        await machine.ws.send_json({"type": "http", "id": request_id,
                                    "method": request.method, "path": tail,
                                    "body": body, "caller": caller.public(),
                                    "request_id": request.headers.get("X-Leo-Request-Id", "")})
        try:
            frame = await asyncio.wait_for(fut, timeout=REQUEST_TIMEOUT_S)
        except (asyncio.TimeoutError, ConnectionError):
            machine.pending.pop(request_id, None)
            return web.json_response(
                {"error": {"message": "这台 Mac 没有按时响应"}}, status=504)
        return web.json_response(frame.get("body"), status=int(frame.get("status") or 200))

    @staticmethod
    def _coalescible(data: Any) -> Optional[Dict[str, Any]]:
        """转发时可以合并的帧:正文增量 message.delta,和不带 seq 的 journal.status 状态快照。

        思考(reasoning.available)不合并:iOS 每条思考单独成一行,桌面端本来就整段发一次;
        按到达时间拼起来,实时流和续传看到的分行会不一样。
        """
        if not isinstance(data, str) or ('"message.delta"' not in data
                                         and '"journal.status"' not in data):
            return None
        try:
            event = json.loads(data)
        except ValueError:
            return None
        if not isinstance(event, dict):
            return None
        if event.get("event") == "message.delta" and isinstance(event.get("delta"), str):
            return event
        if event.get("event") == "journal.status" and "seq" not in event:
            return event
        return None

    @staticmethod
    def _joins(prev: Dict[str, Any], event: Dict[str, Any]) -> bool:
        """两条正文增量只差 delta / seq / timestamp 才合并;durability 之类一变就分开发。

        seq 必须递增:万一来了重复帧,要留给手机按 seq 去重,不能拼进正文里。
        """
        if event.get("event") != "message.delta" or prev.keys() != event.keys():
            return False
        if "seq" in event and not (isinstance(prev["seq"], int) and isinstance(event["seq"], int)
                                   and event["seq"] > prev["seq"]):
            return False
        return all(prev[k] == event[k] for k in event if k not in ("delta", "seq", "timestamp"))

    async def _forward_stream(self, request: web.Request, machine: Machine,
                              tail: str, caller: Optional[Caller] = None) -> web.StreamResponse:
        stream_id = uuid.uuid4().hex
        queue: asyncio.Queue = asyncio.Queue(maxsize=1024)
        machine.streams[stream_id] = queue
        response = web.StreamResponse(headers={
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        })
        await response.prepare(request)
        await machine.ws.send_json({"type": "stream_open", "id": stream_id, "path": tail,
                                    "caller": caller.public() if caller else {}})
        loop = asyncio.get_running_loop()
        # 攒着还没发的正文:[首帧原文, 最近一帧, 各段 delta];外加攒的这段时间里最新的
        # 一条 journal.status(iOS 带 journal_status=1 时,桌面端每条事件前后都插一条
        # 状态快照;新的覆盖旧的,正文发完紧跟着发——要是见一条就先发正文,iOS 这条
        # 最常用的路径上一段也合并不了)。
        # 攒着的正文 seq 还没到手机,续传游标停在它们之前:手机断线时这截直接丢掉
        # 也不少字,重连 ?after=N 由 Mac 的事件日志原样补回。
        pending: Optional[List[Any]] = None
        status: Optional[str] = None
        deadline = 0.0

        async def flush() -> None:
            nonlocal pending, status
            if pending is not None:
                raw, last, parts = pending
                pending = None
                if len(parts) > 1:
                    # 合成帧 = 最后一帧换上拼好的正文,seq 用最后一段的:手机按它续传正好
                    # 接在这截之后,不重不漏。ensure_ascii 保持默认:拼接处可能是被切开的
                    # 代理对,转义输出永远是合法 JSON,手机解析时自动拼回。
                    raw = json.dumps({**last, "delta": "".join(parts)})
                await response.write(f"data: {raw}\n\n".encode("utf-8"))
            if status is not None:
                raw, status = status, None
                await response.write(f"data: {raw}\n\n".encode("utf-8"))

        try:
            while True:
                if pending is not None and loop.time() >= deadline:
                    await flush()
                # 队列里有就直接拿,一口气清完(一帧一个 wait_for 在 3.9 上每帧要转好几圈
                # 事件循环,大段回放时追不上 Mac,好好的手机也会被当成慢消费者关流)。
                try:
                    frame = queue.get_nowait()
                except asyncio.QueueEmpty:
                    if pending is None:
                        frame = await queue.get()
                    else:
                        try:
                            frame = await asyncio.wait_for(
                                queue.get(), max(0.0, deadline - loop.time()))
                        except asyncio.TimeoutError:
                            await flush()
                            continue
                kind = frame.get("type")
                data = frame.get("data")
                event = self._coalescible(data) if kind == "stream_data" else None
                if pending is not None and event is not None:
                    if event["event"] == "journal.status":
                        status = data
                        continue
                    if self._joins(pending[1], event):
                        pending[1] = event
                        pending[2].append(event["delta"])
                        continue
                # 其余一切(工具、审批、终态、续传信封、保活、关流)先把攒着的发出去,顺序不变。
                await flush()
                if event is not None and event["event"] == "message.delta":
                    pending = [data, event, [event["delta"]]]
                    deadline = loop.time() + DELTA_COALESCE_S
                elif kind == "stream_close":
                    break
                elif kind == "stream_keepalive":
                    # SSE 注释帧:客户端(iOS / 中继 / 网页)都只认 `data:` 前缀,
                    # 会安全跳过它,但它足以让中间的代理和 NAT 知道这条连接还活着。
                    await response.write(b": keep-alive\n\n")
                elif data:
                    await response.write(f"data: {data}\n\n".encode("utf-8"))
        except (ConnectionResetError, asyncio.CancelledError):
            pass  # 手机走了;通知 Mac 停推
        finally:
            machine.streams.pop(stream_id, None)
            # 手机断开时 aiohttp 是**取消**这个 handler 任务的,于是这里的
            # await 会立刻抛 CancelledError —— 而 `except Exception` 接不住它
            # (CancelledError 在 3.8+ 直接继承 BaseException)。结果就是
            # stream_cancel 根本发不出去:Mac 那边的上游连接没人叫停,一直挂着
            # 读到 sock_read 超时为止。shield 让这次发送独立于本任务的取消跑完,
            # 外层的 BaseException 只是把"本任务已被取消"这件事咽掉。
            try:
                await asyncio.shield(
                    machine.ws.send_json({"type": "stream_cancel", "id": stream_id}))
            except BaseException:  # noqa: BLE001
                pass
        return response

    # -- 离线排队 --------------------------------------------------------------

    async def _enqueue(self, request: web.Request, name: str, tail: str, caller: Caller) -> web.Response:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = None
        now = time.time()
        items = [i for i in self.offline_queue.get(name, []) if now - i["queued_at"] < QUEUE_TTL_S]
        if len(items) >= QUEUE_LIMIT_PER_MACHINE:
            return web.json_response({"error": {"message": "排队的任务太多了,等 Mac 上线再发"}}, status=429)
        request_id = request.headers.get("X-Leo-Request-Id", "").strip() or uuid.uuid4().hex
        if not any(i["request_id"] == request_id for i in items):
            items.append({"request_id": request_id, "method": request.method, "path": tail,
                          "body": body, "caller": caller.public(), "queued_at": now})
        self.offline_queue[name] = items
        return web.json_response({"queued": True, "request_id": request_id}, status=202)

    async def _flush_queue(self, machine: Machine) -> None:
        """Mac 上线后按顺序投递排队的请求,结果留 24 小时供手机查询。"""
        items = self.offline_queue.pop(machine.name, [])
        now = time.time()
        for item in items:
            if now - item["queued_at"] >= QUEUE_TTL_S:
                self.queue_results[item["request_id"]] = {"status": "expired", "at": now}
                continue
            if self.machines.get(machine.name) is not machine:
                # 投递途中又断了:剩下的放回队首,等下一次上线。
                rest = items[items.index(item):]
                self.offline_queue[machine.name] = rest + self.offline_queue.get(machine.name, [])
                return
            fut: asyncio.Future = asyncio.get_running_loop().create_future()
            frame_id = uuid.uuid4().hex
            machine.pending[frame_id] = fut
            try:
                await machine.ws.send_json({"type": "http", "id": frame_id, "method": item["method"],
                                            "path": item["path"], "body": item["body"],
                                            "caller": item["caller"], "request_id": item["request_id"]})
                frame = await asyncio.wait_for(fut, timeout=REQUEST_TIMEOUT_S)
                self.queue_results[item["request_id"]] = {
                    "status": "delivered", "at": time.time(),
                    "http_status": int(frame.get("status") or 200), "response": frame.get("body"),
                }
            except (asyncio.TimeoutError, ConnectionError) as exc:
                machine.pending.pop(frame_id, None)
                self.queue_results[item["request_id"]] = {"status": "failed", "at": time.time(),
                                                          "error": str(exc) or "timeout"}
        cutoff = time.time() - QUEUE_TTL_S
        for rid in [rid for rid, r in self.queue_results.items() if r.get("at", 0) < cutoff]:
            self.queue_results.pop(rid, None)

    # -- wiring ---------------------------------------------------------------

    def build_app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/relay/health", self.health)
        app.router.add_get("/relay/agent", self.agent_ws)
        app.router.add_get("/relay/api/machines", self.list_machines)
        app.router.add_get("/relay/api/events", self.list_events)
        app.router.add_post("/relay/api/device", self.register_device)
        app.router.add_post("/relay/api/join-tokens", self.create_join_token)
        app.router.add_delete("/relay/api/join-tokens/{token}", self.delete_join_token)
        app.router.add_post("/relay/api/join", self.join)
        app.router.add_get("/relay/api/join/{pending_id}", self.join_status)
        app.router.add_get("/relay/api/join-requests", self.list_join_requests)
        app.router.add_post("/relay/api/join-requests/{pending_id}", self.decide_join_request)
        app.router.add_post("/relay/api/device/exchange", self.device_exchange)
        app.router.add_get("/relay/api/devices", self.list_devices)
        app.router.add_delete("/relay/api/devices/{device_id}", self.revoke_device)
        app.router.add_post("/relay/api/admin/rotate", self.rotate_keys)
        app.router.add_post("/relay/api/machines/{name}/unpin", self.unpin_machine)
        app.router.add_get("/relay/api/queue/{request_id}", self.queue_status)
        app.router.add_get("/relay/api/push-status", self.push_status)
        app.router.add_put("/relay/api/collections", self.put_collections)
        app.router.add_get("/relay/api/collections", self.get_collections)
        app.router.add_post("/relay/api/treasury/changes", self.post_treasury_changes)
        app.router.add_get("/relay/api/treasury/changes", self.get_treasury_changes)
        app.router.add_get("/relay/api/treasury/items", self.get_treasury_items)
        app.router.add_post("/relay/api/treasury/assets/requests", self.post_treasury_asset_request)
        app.router.add_get("/relay/api/treasury/assets/requests", self.get_treasury_asset_requests)
        app.router.add_put("/relay/api/treasury/assets/{request_id}", self.put_treasury_asset)
        app.router.add_get("/relay/api/treasury/assets/{request_id}", self.get_treasury_asset)
        app.router.add_post(
            "/relay/api/treasury/assets/{request_id}/unavailable",
            self.post_treasury_asset_unavailable,
        )
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
