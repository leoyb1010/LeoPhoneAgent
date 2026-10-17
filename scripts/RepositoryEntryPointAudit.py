#!/usr/bin/env python3
"""Guard the human and CI entry points against mixing active and legacy apps."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
readme = (ROOT / "README.md").read_text()
project = (ROOT / "src/ios/LeoPhoneAgent.xcodeproj/project.pbxproj").read_text()
version = re.search(r"MARKETING_VERSION = ([^;]+);", project).group(1)
build = re.search(r"CURRENT_PROJECT_VERSION = ([^;]+);", project).group(1)
mac = json.loads((ROOT / "src/mac/leophone/package.json").read_text())
assert f"iOS-{version}%20({build})" in readme, "README iOS source badge drifted"
assert f"macOS_source-{mac['version']}" in readme, "README current Mac source badge drifted"
intro = readme.split("## 开发 Agent 先读", 1)[1].split("## HarmonyOS", 1)[0]
assert "`src/mac/leophone/`（当前 1.x 主线）" in intro
workflow = (ROOT / ".github/workflows/ios-tests.yml").read_text()
assert "working-directory: src/mac/leophone" in workflow
assert "cache-dependency-path: src/mac/leophone/pnpm-lock.yaml" in workflow
# WP-03(2026-10):Android / Harmony 冻结,代码留在 archive/android-harmony 分支,CI 入口必须已移除,
# 防止有人把它们当活跃工程又挂回来却没人维护。
for frozen in ("android.yml", "android-product-ui.yml"):
    assert not (ROOT / ".github/workflows" / frozen).exists(), f"{frozen} should stay frozen (WP-03)"
assert "harmony-source-tests" not in workflow, "Harmony CI job should stay frozen (WP-03)"
print(f"RepositoryEntryPointAudit: iOS {version} ({build}), active Mac {mac['version']}, Android/Harmony CI frozen")
