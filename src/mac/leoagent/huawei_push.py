"""HarmonyOS Push V3. Configuration lives outside the checkout in huawei-push.json.

Configuration keys are project_id, service_account_path, test_message (default True).
The service account JSON is the unmodified AGC download (key_id/sub_account/private_key).
References: Huawei push-jwt-token, push-send-alert, push-scenariozed-api-request-struct.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any, Callable

try:
    import jwt
    import httpx
except ImportError:  # Existing APNs dependencies also provide these packages.
    jwt = None
    httpx = None

BUNDLE_ID = "com.leoyuan.leophoneagent.harmony"
AUDIENCE = "https://oauth-login.cloud.huawei.com/oauth2/v3/token"
ENDPOINT = "https://push-api.cloud.huawei.com/v3/{project}/messages:send"


class HuaweiPusher:
    def __init__(self, home: Path):
        self.home = Path(home)
        self.path = self.home / "huawei-devices.json"
        self.config = self._config()
        self._corrupt = False
        try:
            self._data = self._load()
        except (OSError, ValueError, TypeError, AttributeError):
            self._corrupt = True
            self._data = {"devices": {}, "sent": {}}
        self._lock: asyncio.Lock | None = None
        self._jwt = ""
        self._jwt_at = 0.0

    def _config(self) -> dict[str, Any] | None:
        try:
            value = json.loads((self.home / "huawei-push.json").read_text())
            project = str(value.get("project_id") or "")
            account = Path(str(value.get("service_account_path") or "")).expanduser()
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", project) or not account.is_file():
                return None
            return {"project_id": project, "service_account_path": str(account),
                    "test_message": value.get("test_message", True) is not False}
        except (OSError, ValueError, TypeError, AttributeError):
            return None

    @property
    def enabled(self) -> bool:
        return not self._corrupt and self.config is not None and jwt is not None and httpx is not None

    def status(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "registered": len(self._data["devices"]),
                "test_message": bool(self.config and self.config["test_message"]), "registry_error": self._corrupt}

    def _load(self) -> dict[str, Any]:
        try:
            data = json.loads(self.path.read_text())
            if not isinstance(data.get("devices"), dict) or not isinstance(data.get("sent"), dict):
                raise ValueError("invalid Huawei push registry")
            for token, meta in data["devices"].items():
                if not isinstance(token, str) or not isinstance(meta, dict) or not isinstance(meta.get("owner"), str):
                    raise ValueError("invalid Huawei destination")
            for timestamp in data["sent"].values():
                if not isinstance(timestamp, (float, int)):
                    raise ValueError("invalid Huawei receipt")
            return data
        except FileNotFoundError:
            return {"devices": {}, "sent": {}}
        # Corrupt state is not silently replaced by an empty registry.

    def _save(self, data: dict[str, Any]) -> None:
        if self._corrupt:
            raise OSError("Huawei push registry needs recovery")
        self.home.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".huawei-devices-", dir=self.home)
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(data, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            self._data = data
            directory = os.open(self.home, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def register(self, owner: str, token: str, bundle_id: str) -> bool:
        if (not owner or not isinstance(token, str) or not 16 <= len(token) <= 4096
                or not re.fullmatch(r"[A-Za-z0-9_:.+\-/=]+", token) or bundle_id != BUNDLE_ID):
            return False
        existing = self._data["devices"].get(token)
        if existing and existing.get("owner") != owner:
            return False
        # Token refresh replaces the owner's previous destination only after durable commit.
        devices = {key: value for key, value in self._data["devices"].items()
                   if value.get("owner") != owner}
        devices[token] = {"owner": owner, "bundle_id": bundle_id, "updated_at": time.time()}
        self._save({"devices": devices, "sent": dict(self._data["sent"])})
        return True

    def forget_owner(self, owner: str) -> None:
        devices = {key: value for key, value in self._data["devices"].items()
                   if value.get("owner") != owner}
        self._save({"devices": devices, "sent": dict(self._data["sent"])})

    def _authorization(self) -> str:
        if not self.config or jwt is None:
            raise RuntimeError("Huawei push is not configured")
        now = int(time.time())
        if not self._jwt or now - self._jwt_at >= 3000:
            account = json.loads(Path(self.config["service_account_path"]).read_text())
            self._jwt = jwt.encode({"iss": account["sub_account"], "aud": AUDIENCE,
                                    "iat": now, "exp": now + 3600}, account["private_key"],
                                   algorithm="PS256", headers={"kid": account["key_id"], "typ": "JWT"})
            self._jwt_at = now
        return self._jwt

    async def send_event(self, machine: str, event: dict[str, Any],
                         owner_allowed: Callable[[str], bool]) -> int:
        kind = str(event.get("event") or "")
        session = str(event.get("session_id") or "")
        if (not self.enabled or kind not in {"approval.request", "run.completed", "automation.run.completed"}
                or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", machine)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session)):
            return 0
        identity = [machine, kind, session, str(event.get("approval_id") or ""),
                    str(event.get("seq") or event.get("run_id") or event.get("timestamp") or "")]
        digest = hashlib.sha256(json.dumps(identity).encode()).hexdigest()
        title = "LeoBot 等你审批" if kind == "approval.request" else "LeoBot 任务已完成"
        count = 0
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            for token, meta in list(self._data["devices"].items()):
                owner = str(meta.get("owner") or "")
                if not owner_allowed(owner) or self._data["devices"].get(token) != meta:
                    continue
                key = hashlib.sha256((owner + digest).encode()).hexdigest()
                if time.time() - float(self._data["sent"].get(key, 0)) < 86400:
                    continue
                notification = {"category": "WORK", "title": title,
                                "body": "打开 LeoBot 查看任务", "notifyId": int(digest[:7], 16),
                                "clickAction": {"actionType": 0, "data": {
                                    "machine": machine, "session_id": session}}}
                body = {"payload": {"notification": notification}, "target": {"token": [token]},
                        "pushOptions": {"testMessage": self.config["test_message"], "ttl": 3600}}
                try:
                    async with httpx.AsyncClient(timeout=15, follow_redirects=False) as client:
                        response = await client.post(ENDPOINT.format(project=self.config["project_id"]),
                                                     headers={"Authorization": "Bearer " + self._authorization(),
                                                              "push-type": "0"}, json=body)
                    if response.status_code != 200:
                        continue
                    result = response.json()
                    if str(result.get("code")) != "80000000":
                        continue
                    count += 1
                    sent = {entry: timestamp for entry, timestamp in self._data["sent"].items()
                            if time.time() - float(timestamp) < 86400}
                    sent[key] = time.time()
                    sent = dict(sorted(sent.items(), key=lambda pair: pair[1])[-1024:])
                    self._save({"devices": dict(self._data["devices"]), "sent": sent})
                except Exception:
                    # Never surface vendor exception bodies, headers, credentials or push tokens.
                    continue
        return count


def build_huawei_pusher(home: Path) -> HuaweiPusher:
    return HuaweiPusher(home)
