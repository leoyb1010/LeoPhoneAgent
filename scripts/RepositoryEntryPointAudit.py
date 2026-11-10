#!/usr/bin/env python3
"""Guard the human and CI entry points of the canonical LeoBot checkout.

Checks (every failure is reported; exit 1 if any):
  * README iOS / macOS / HarmonyOS / Android source badges match the real
    project files (pbxproj, package.json, app.json5, build.gradle.kts).
  * HarmonyOS ReleaseCatalog matches app.json5 (version + build).
  * "开发 Agent 先读" names exactly one development checkout, `~/leophone-mac`
    on `main`; any other local checkout path there is a stale copy entry.
  * HarmonyOS CI is active: .github/workflows/harmony-protocol.yml must equal
    the output of scripts/HarmonyCIWorkflow.py byte for byte (hosted ubuntu,
    push+PR triggers, full protocol/UI-token/release-notes checks).
  * ios-tests.yml still references the Mac 1.x job (presence only).
    Android/Harmony are active products; nothing here forbids their CI.

Usage: RepositoryEntryPointAudit.py [--root DIR]   (DIR defaults to the repo)
Uses explicit checks instead of `assert` so `python -O` cannot disable them.
"""
import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import HarmonyCIWorkflow as harmony_ci  # noqa: E402  single maintained workflow source

CANONICAL_CHECKOUT = "~/leophone-mac"


def read(root, rel, errors):
    path = root / rel
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"missing {rel}: {exc.strerror}")
        return None


def match(pattern, text, what, errors):
    found = re.search(pattern, text or "")
    if not found:
        errors.append(f"cannot read {what}")
        return None
    return found.group(1)


def shield(value):
    """shields.io badge text escaping: '-' -> '--', ' ' -> '%20'."""
    return value.replace("-", "--").replace(" ", "%20")


def audit(root):
    errors, summary = [], {}
    readme = read(root, "README.md", errors) or ""

    project = read(root, "src/ios/LeoPhoneAgent.xcodeproj/project.pbxproj", errors)
    ios_version = match(r"MARKETING_VERSION = ([^;]+);", project, "iOS MARKETING_VERSION", errors)
    ios_build = match(r"CURRENT_PROJECT_VERSION = ([^;]+);", project, "iOS CURRENT_PROJECT_VERSION", errors)
    if ios_version and ios_build:
        summary["iOS"] = f"{ios_version} ({ios_build})"
        if f"badge/iOS-{shield(ios_version)}%20({ios_build})-" not in readme:
            errors.append(f"README iOS badge does not show source {ios_version} ({ios_build})")

    mac_text = read(root, "src/mac/leophone/package.json", errors)
    if mac_text:
        mac_version = json.loads(mac_text).get("version", "")
        summary["Mac"] = mac_version
        if f"badge/macOS_source-{shield(mac_version)}-" not in readme:
            errors.append(f"README macOS source badge does not show {mac_version}")

    app = read(root, "src/harmony/app/AppScope/app.json5", errors)
    h_name = match(r'"versionName"\s*:\s*"([^"]+)"', app, "Harmony versionName", errors)
    h_code = match(r'"versionCode"\s*:\s*(\d+)', app, "Harmony versionCode", errors)
    catalog = read(root, "src/harmony/app/entry/src/main/ets/release/ReleaseCatalog.ets", errors)
    c_name = match(r"currentVersion:\s*string\s*=\s*'([^']+)'", catalog, "Harmony ReleaseCatalog.currentVersion", errors)
    c_code = match(r"currentBuild:\s*number\s*=\s*(\d+)", catalog, "Harmony ReleaseCatalog.currentBuild", errors)
    if h_name and h_code:
        summary["Harmony"] = f"{h_name} ({h_code})"
        if f"badge/HarmonyOS_source-{shield(h_name)}-" not in readme:
            errors.append(f"README HarmonyOS source badge does not show app.json5 {h_name}")
        if c_name and c_name != h_name:
            errors.append(f"Harmony ReleaseCatalog.currentVersion {c_name} != app.json5 {h_name}")
        if c_code and c_code != h_code:
            errors.append(f"Harmony ReleaseCatalog.currentBuild {c_code} != app.json5 {h_code}")

    gradle = read(root, "src/android/app/build.gradle.kts", errors)
    a_name = match(r'versionName\s*=\s*"([^"]+)"', gradle, "Android versionName", errors)
    if a_name:
        summary["Android"] = a_name
        if f"badge/Android-{shield(a_name)}-" not in readme:
            errors.append(f"README Android badge does not show build.gradle.kts {a_name}")
        for flavor in ("standard", "power"):
            if f'create("{flavor}")' not in (gradle or ""):
                errors.append(f"Android flavor {flavor} missing from build.gradle.kts")

    # Single development entry point.
    if "## 开发 Agent 先读" not in readme:
        errors.append("README lacks the 开发 Agent 先读 section")
    else:
        intro = re.split(r"\n## ", readme.split("## 开发 Agent 先读", 1)[1], maxsplit=1)[0]
        entry = [l for l in intro.splitlines() if "唯一权威开发入口" in l]
        if len(entry) != 1:
            errors.append(f"README must name exactly one 唯一权威开发入口 line (found {len(entry)})")
        elif f"`{CANONICAL_CHECKOUT}` 的 `main`" not in entry[0]:
            errors.append(f"README development entry is not `{CANONICAL_CHECKOUT}` 的 `main`")
        local_paths = set(re.findall(r"(?:~|/Users/[^/\s`]+|/Volumes/[^`\s]+)/[^\s`'\"，。；）)]+", intro))
        stale = sorted(p for p in local_paths if p.rstrip("/") != CANONICAL_CHECKOUT)
        if stale:
            errors.append("README development intro names non-canonical checkouts: " + ", ".join(stale))
        if "`src/mac/leophone/`（当前 1.x 主线）" not in intro:
            errors.append("README intro no longer names src/mac/leophone/ as the current Mac 1.x line")

    # Active CI.
    # HarmonyOS: the workflow is generated by scripts/HarmonyCIWorkflow.py and must be
    # byte-identical to its output. That fixes events, hosted runner, job, steps and the
    # full checks block, so if:false / continue-on-error / echo-only gates / runner groups /
    # quoted or duplicate keys / dispatch-only triggers all fail closed.
    harmony_problems = harmony_ci.check(root)
    errors.extend(harmony_problems)
    if not harmony_problems:
        summary["HarmonyCI"] = harmony_ci.WORKFLOW_REL
    # Mac 1.x: ios-tests.yml is hand-maintained; this is a presence check only (it does not
    # prove the job is enabled). Its activity is outside this audit's generated scope.
    mac_ci = read(root, ".github/workflows/ios-tests.yml", errors) or ""
    if not ("working-directory: src/mac/leophone" in mac_ci and
            "cache-dependency-path: src/mac/leophone/pnpm-lock.yaml" in mac_ci):
        errors.append("ios-tests.yml no longer references the src/mac/leophone job and pnpm lockfile")
    return errors, summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    errors, summary = audit(args.root.resolve())
    if errors:
        for e in errors:
            print(f"RepositoryEntryPointAudit: FAIL {e}", file=sys.stderr)
        return 1
    print("RepositoryEntryPointAudit: OK " + ", ".join(f"{k} {v}" for k, v in summary.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
