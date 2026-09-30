"""Relay identity registry validation, before any remote admission."""

import math
import re
from typing import Any


def valid_registry(value: Any) -> bool:
    """损坏的身份状态不能按新安装解释，否则旧主钥匙与机器名权限会复活。"""
    if not isinstance(value, dict) or value.get("version") != 2:
        return False
    required = {"devices", "revoked_devices", "pins", "register_key_hash", "master_expires_at"}
    if not required.issubset(value):
        return False
    digest = lambda v: isinstance(v, str) and re.fullmatch(r"[a-f0-9]{64}", v) is not None
    timestamp = lambda v: type(v) in (int, float) and math.isfinite(v) and v >= 0
    # 已发布 writer 从未限制机器名长度；读写须兼容旧的长名称 pin。
    identifier = lambda v: isinstance(v, str) and bool(v)
    devices, pins = value["devices"], value["pins"]
    revoked = value["revoked_devices"]
    if not isinstance(devices, dict) or not isinstance(pins, dict) or not isinstance(revoked, list):
        return False
    if any(not identifier(v) for v in revoked):
        return False
    if any(not identifier(k) or not digest(v) for k, v in pins.items()):
        return False
    if value["register_key_hash"] is not None and not digest(value["register_key_hash"]):
        return False
    if value["master_expires_at"] is not None and not timestamp(value["master_expires_at"]):
        return False
    hashes = set()
    for key, row in devices.items():
        if not identifier(key) or not isinstance(row, dict):
            return False
        if row.get("kind") not in ("iphone", "legacy") or not digest(row.get("key_hash")):
            return False
        if not isinstance(row.get("name"), str) or any(
            not timestamp(row.get(field)) for field in ("created_at", "last_seen", "expires_at")
        ):
            return False
        if row["key_hash"] in hashes or key in revoked:
            return False
        hashes.add(row["key_hash"])
        if row.get("push") is not None and not isinstance(row["push"], dict):
            return False
    return True
