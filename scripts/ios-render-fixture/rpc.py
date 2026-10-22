#!/usr/bin/env python3
"""Tiny JSON-RPC client for a DEBUG build's debug server (simulator only).

The simulator must have `debug.auth.required` = NO, e.g.
  xcrun simctl spawn <udid> defaults write <bundle-id> debug.auth.required -bool NO

  python3 rpc.py <method> '<json params>'
  python3 rpc.py setup-fixture   # provider -> fake SSE server, prints {"instanceId","entryId"}
"""
from __future__ import annotations
import json
import sys
import urllib.request

URL = "http://127.0.0.1:8321/rpc"


def call(method: str, params: dict | None = None, timeout: float = 120):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).encode()
    req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        out = json.loads(resp.read())
    if "error" in out:
        raise SystemExit(f"{method}: {out['error']}")
    return out.get("result")


def setup_fixture(port: int = 8799):
    inst = call("provider.instances.create", {
        "providerType": "openAI", "label": "Render Fixture", "apiKey": "fixture-test-key",
        "customBaseURL": f"http://127.0.0.1:{port}/v1", "appendV1Suffix": False,
        "seedBuiltInModels": False,
    })
    iid = inst.get("instanceId") or inst.get("id") or inst.get("instance", {}).get("id")
    entry = call("provider.models.add", {"instanceId": iid, "modelId": "fixture-model",
                                         "displayName": "Fixture", "contextWindow": 128000,
                                         "maxOutputTokens": 8192, "supportsReasoning": True})
    eid = entry.get("entryId") or entry.get("id") or entry.get("entry", {}).get("id")
    return {"instanceId": iid, "entryId": eid, "raw": [inst, entry]}


if __name__ == "__main__":
    if sys.argv[1] == "setup-fixture":
        print(json.dumps(setup_fixture(), ensure_ascii=False))
    else:
        params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
        print(json.dumps(call(sys.argv[1], params), ensure_ascii=False, indent=1)[:20000])
