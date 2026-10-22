#!/usr/bin/env python3
"""[up-b-ci] 给自托管 runner 选 iOS 模拟器 UDID(只复用现有设备,绝不 simctl create / clone)。

用法:CISelectIOSSimulator.py [iphone|ipad](默认 iphone)
1. 本机有模拟器策略脚本(~/.config/apple-simulator-policy/simulators.py)就用它的白名单设备。
2. 否则从 `xcrun simctl list devices available -j` 里挑 iOS 27 运行时上的该类设备:
   iPhone 优先 LEO_CI_SIMULATOR_NAME(默认 "iPhone 18 Pro Max"),其次按名字排序的第一台。
   项目 deployment target 是 iOS 27.0,低版本运行时跑不了,找不到就失败退出(不创建)。
只往 stdout 打 UDID,说明写 stderr。
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

UDID = re.compile(r"^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$", re.I)
policy = Path.home() / ".config/apple-simulator-policy/simulators.py"
family = sys.argv[1] if len(sys.argv) > 1 else "iphone"
if family not in ("iphone", "ipad"):
    raise SystemExit(f"simulator: unknown device family {family!r} (iphone|ipad)")
prefix = "iPad" if family == "ipad" else "iPhone"

if policy.is_file():
    out = subprocess.run([sys.executable, str(policy), "id", family], capture_output=True, text=True)
    udid = out.stdout.strip().splitlines()[-1] if out.stdout.strip() else ""
    if out.returncode == 0 and UDID.match(udid):
        print(f"simulator: policy whitelist {prefix} {udid}", file=sys.stderr)
        print(udid)
        raise SystemExit(0)
    print(f"simulator: policy script present but gave no UDID ({out.stderr.strip()}); falling back", file=sys.stderr)

listing = json.loads(subprocess.run(["xcrun", "simctl", "list", "devices", "available", "-j"],
                                    capture_output=True, text=True, check=True).stdout)
phones = [d for runtime, devices in listing.get("devices", {}).items()
          if re.search(r"\.iOS-27(-|$)", runtime)
          for d in devices if d.get("name", "").startswith(prefix) and d.get("isAvailable", True)]
if not phones:
    raise SystemExit(f"simulator: no available {prefix} on an iOS 27 runtime; refusing to create one")
wanted = os.environ.get("LEO_CI_SIMULATOR_NAME", "iPhone 18 Pro Max") if family == "iphone" else None
pick = next((d for d in phones if d["name"] == wanted), None) or sorted(phones, key=lambda d: d["name"])[0]
print(f"simulator: {pick['name']} {pick['udid']} (no policy script; chose from simctl list)", file=sys.stderr)
print(pick["udid"])
