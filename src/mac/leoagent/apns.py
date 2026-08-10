"""APNs 推送器 —— 让 Mac 上的事件在手机 app 完全没运行时也能响。

为什么中继来干这件事:手机没连着时,harness 的 SSE 通道根本不存在,
事件只躺在 Mac 本地。Mac 把关键事件外推给中继(relay_client.push_event),
中继在这里转成 APNs 推送。

认证用 .p8 token(不是证书):一把 key 走完 development 与 production,
不过期、不用续签。token 每 50 分钟重签一次(Apple 要求 <1 小时)。

设备登记在 ~/.leoagent/devices.json:
    {"device": {token: {bundle_id, environment, updated_at}},
     "push_to_start": {...}}
APNs 回 410(BadDeviceToken/Unregistered)即自动摘除,不留幽灵 token。
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import jwt  # PyJWT
except ImportError:  # pragma: no cover - 未装依赖时优雅降级
    jwt = None  # type: ignore

# APNs 只接受 HTTP/2。aiohttp 只会 HTTP/1.1,真机实测直接被拒:
# "Unexpected HTTP/1.x request: POST /3/device/…"。httpx 带 h2 才行。
try:
    import httpx
    import h2  # noqa: F401  http2=True 需要它;缺了 AsyncClient 构造时才炸
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore


APNS_HOSTS = {
    "development": "https://api.sandbox.push.apple.com",
    "production": "https://api.push.apple.com",
}

TOKEN_TTL_S = 50 * 60


class APNsPusher:
    """一个中继一个实例。没配 .p8 就整体静默禁用,不影响中继本体。"""

    def __init__(self, home: Optional[Path] = None):
        self.home = home or Path(os.path.expanduser("~/.leoagent"))
        self.devices_path = self.home / "devices.json"
        self.config = self._load_config()
        self._token: Optional[str] = None
        self._token_at: float = 0.0

    # -- 配置 ---------------------------------------------------------------

    def _load_config(self) -> Optional[Dict[str, str]]:
        """~/.leoagent/apns.json:{key_path, key_id, team_id, topic}

        topic = app 的 bundle id。Live Activity 推送要在它后面加
        ".push-type.liveactivity",这里只存基础值。
        """
        path = self.home / "apns.json"
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            return None
        needed = ("key_path", "key_id", "team_id", "topic")
        if not all(str(data.get(k) or "").strip() for k in needed):
            return None
        if not Path(os.path.expanduser(str(data["key_path"]))).exists():
            return None
        return {k: str(data[k]).strip() for k in needed}

    @property
    def enabled(self) -> bool:
        return self.config is not None and jwt is not None and httpx is not None

    def status(self) -> Dict[str, Any]:
        """给诊断用:为什么没启用,一眼看得出来。"""
        return {
            "enabled": self.enabled,
            "has_config": self.config is not None,
            "has_pyjwt": jwt is not None,
            "has_http2": httpx is not None,
            "devices": {k: len(v) for k, v in self._load_devices().items()},
        }

    # -- 鉴权 token ---------------------------------------------------------

    def _auth_token(self) -> Optional[str]:
        if not self.config or jwt is None:
            return None
        now = time.time()
        if self._token and now - self._token_at < TOKEN_TTL_S:
            return self._token
        try:
            key = Path(os.path.expanduser(self.config["key_path"])).read_text()
            self._token = jwt.encode(
                {"iss": self.config["team_id"], "iat": int(now)},
                key,
                algorithm="ES256",
                headers={"kid": self.config["key_id"]},
            )
            self._token_at = now
            return self._token
        except Exception as exc:  # noqa: BLE001
            print(f"[apns] token sign failed: {exc}", flush=True)
            return None

    # -- 设备登记 -----------------------------------------------------------

    def _load_devices(self) -> Dict[str, Dict[str, Any]]:
        try:
            data = json.loads(self.devices_path.read_text())
        except (OSError, json.JSONDecodeError):
            return {"device": {}, "push_to_start": {}}
        for bucket in ("device", "push_to_start"):
            data.setdefault(bucket, {})
        return data

    def _save_devices(self, data: Dict[str, Dict[str, Any]]) -> None:
        try:
            self.devices_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.devices_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
            os.chmod(tmp, 0o600)
            tmp.replace(self.devices_path)
        except OSError as exc:
            print(f"[apns] save devices failed: {exc}", flush=True)

    def register(self, kind: str, token: str, bundle_id: str, environment: str) -> bool:
        """登记一个 token。kind ∈ {device, push_to_start}。"""
        token = (token or "").strip().lower()
        if kind not in ("device", "push_to_start") or len(token) < 32:
            return False
        if environment not in APNS_HOSTS:
            environment = "development"
        data = self._load_devices()
        data[kind][token] = {
            "bundle_id": bundle_id or "",
            "environment": environment,
            "updated_at": time.time(),
        }
        self._save_devices(data)
        print(f"[apns] registered {kind} token …{token[-8:]} ({environment})", flush=True)
        return True

    def _forget(self, kind: str, token: str) -> None:
        data = self._load_devices()
        if data.get(kind, {}).pop(token, None) is not None:
            self._save_devices(data)
            print(f"[apns] dropped stale {kind} token …{token[-8:]}", flush=True)

    # -- 发送 ---------------------------------------------------------------

    async def _post(self, client, host: str, path: str, headers: Dict[str, str],
                    payload: Dict[str, Any]) -> Tuple[int, str]:
        resp = await client.post(f"{host}{path}", headers=headers,
                                 content=json.dumps(payload).encode())
        return resp.status_code, resp.text

    async def send_alert(self, title: str, body: str, user_info: Dict[str, Any],
                         category: Optional[str] = None,
                         time_sensitive: bool = False,
                         collapse_id: Optional[str] = None) -> int:
        """给所有已登记设备发一条可交互通知。返回成功条数。"""
        if not self.enabled:
            return 0
        auth = self._auth_token()
        if not auth or self.config is None:
            return 0
        devices = self._load_devices()["device"]
        if not devices:
            return 0

        aps: Dict[str, Any] = {
            "alert": {"title": title, "body": body[:300]},
            "sound": "default",
        }
        if category:
            aps["category"] = category
        if time_sensitive:
            aps["interruption-level"] = "time-sensitive"
        payload: Dict[str, Any] = {"aps": aps, **user_info}

        sent = 0
        # http2=True 是硬要求,不是优化
        async with httpx.AsyncClient(http2=True, timeout=20) as client:
            for token, meta in list(devices.items()):
                host = APNS_HOSTS.get(meta.get("environment", "development"),
                                      APNS_HOSTS["development"])
                headers = {
                    "authorization": f"bearer {auth}",
                    "apns-topic": meta.get("bundle_id") or self.config["topic"],
                    "apns-push-type": "alert",
                    "apns-priority": "10",
                }
                if collapse_id:
                    # 同一会话的连续事件折叠成一条横幅,而不是刷一屏;
                    # 中继重启后 outbox 补发的重复推送也被折叠掉
                    headers["apns-collapse-id"] = collapse_id[:64]
                try:
                    status, text = await self._post(client, host, f"/3/device/{token}",
                                                    headers, payload)
                except Exception as exc:  # noqa: BLE001
                    print(f"[apns] send failed: {exc}", flush=True)
                    continue
                if status == 200:
                    sent += 1
                    # 成功也留一行:排查时"没日志"与"没发生"分不清,
                    # 这正是刚才把旧的失败记录误读成新失败的原因。
                    print(f"[apns] sent → …{token[-8:]} ({meta.get('environment')})", flush=True)
                elif status in (400, 410) and ("BadDeviceToken" in text or "Unregistered" in text):
                    # 设备重装/换机:摘掉,别留幽灵 token 每次都失败
                    self._forget("device", token)
                else:
                    print(f"[apns] {status} {text[:120]}", flush=True)
        return sent


def build_pusher() -> APNsPusher:
    return APNsPusher()
