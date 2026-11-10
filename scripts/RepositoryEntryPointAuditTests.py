#!/usr/bin/env python3
"""Behaviour tests for RepositoryEntryPointAudit.py and scripts/HarmonyCIWorkflow.py.

Part 1 copies the real audited files of this checkout into a temporary root,
runs the real audit script with --root against it, then mutates one thing per
case and checks the exit code and reported reason.
Part 2 renders the real gate step with scripts/HarmonyCIWorkflow.py (only the
check list is swapped for controlled commands) and runs it with bash to prove
every check runs and the first failing exit code is returned.
Nothing in the repository is written.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / "scripts/RepositoryEntryPointAudit.py"
GENERATOR = ROOT / "scripts/HarmonyCIWorkflow.py"
sys.path.insert(0, str(GENERATOR.parent))
import HarmonyCIWorkflow as harmony_ci  # noqa: E402
FILES = [
    "README.md",
    "src/ios/LeoPhoneAgent.xcodeproj/project.pbxproj",
    "src/mac/leophone/package.json",
    "src/harmony/app/AppScope/app.json5",
    "src/harmony/app/entry/src/main/ets/release/ReleaseCatalog.ets",
    "src/android/app/build.gradle.kts",
]


def make_root(tmp):
    for rel in FILES:
        dst = tmp / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / rel, dst)
    shutil.copytree(ROOT / ".github/workflows", tmp / ".github/workflows")


def edit(tmp, rel, old, new, count=1):
    path = tmp / rel
    text = path.read_text(encoding="utf-8")
    if old not in text:
        raise SystemExit(f"fixture setup: {old!r} not found in {rel}")
    path.write_text(text.replace(old, new, count), encoding="utf-8")


def regex_edit(tmp, rel, pattern, repl):
    path = tmp / rel
    text, n = re.subn(pattern, repl, path.read_text(encoding="utf-8"), count=1, flags=re.M)
    if n != 1:
        raise SystemExit(f"fixture setup: {pattern!r} not found in {rel}")
    path.write_text(text, encoding="utf-8")


HW = harmony_ci.WORKFLOW_REL
DRIFT = "differs from scripts/HarmonyCIWorkflow.py output"


def drop_push_and_pr(t):
    path = t / HW
    text = path.read_text(encoding="utf-8")
    start, end = text.index("  push:\n"), text.index("  workflow_dispatch:\n")
    path.write_text(text[:start] + text[end:], encoding="utf-8")


def crlf(t):
    path = t / HW
    path.write_bytes(path.read_bytes().replace(b"\n", b"\r\n"))


CASES = [
    ("current checkout passes", None, 0, "RepositoryEntryPointAudit: OK"),
    ("Harmony CI workflow missing",
     lambda t: (t / HW).unlink(), 1, "missing " + HW),
    ("Harmony CI drops the UI token gate",
     lambda t: edit(t, HW, "run_check node src/harmony/scripts/check_ui_tokens.mjs\n", ""), 1, DRIFT),
    ("Harmony CI gate only present as a comment",
     lambda t: edit(t, HW, "run_check bash src/harmony/scripts/verify_harmony_release_notes.sh",
                    "# run_check bash src/harmony/scripts/verify_harmony_release_notes.sh"), 1, DRIFT),
    ("Harmony CI gates only echoed",
     lambda t: [edit(t, HW, f"run_check {c}", f"echo {c}") for c in harmony_ci.CHECKS[:3]], 1, DRIFT),
    ("Harmony CI job if: false",
     lambda t: edit(t, HW, "  harmony-protocol-tests:\n", "  harmony-protocol-tests:\n    if: false\n"), 1, DRIFT),
    ("Harmony CI step if: false",
     lambda t: edit(t, HW, "      - name: Run Harmony gates\n",
                    "      - name: Run Harmony gates\n        if: ${{ false }}\n"), 1, DRIFT),
    ("Harmony CI job continue-on-error",
     lambda t: edit(t, HW, "    timeout-minutes: 15\n", "    timeout-minutes: 15\n    continue-on-error: true\n"),
     1, DRIFT),
    ("Harmony CI runner group",
     lambda t: edit(t, HW, "    runs-on: ubuntu-latest\n", "    runs-on:\n      group: private-ubuntu\n"), 1, DRIFT),
    ("Harmony CI moved to a self-hosted runner",
     lambda t: edit(t, HW, "runs-on: ubuntu-latest", "runs-on: [self-hosted, macOS]"), 1, DRIFT),
    ("Harmony CI runner from an expression",
     lambda t: edit(t, HW, "runs-on: ubuntu-latest", "runs-on: ${{ vars.HARMONY_RUNNER }}"), 1, DRIFT),
    ("Harmony CI dispatch-only (push and PR removed)", drop_push_and_pr, 1, DRIFT),
    ("Harmony CI push paths miss src/** cross-platform deps",
     lambda t: edit(t, HW, "      - 'src/**'\n", "      - 'src/harmony/**'\n"), 1, DRIFT),
    ("Harmony CI quoted key overrides runner",
     lambda t: edit(t, HW, "    timeout-minutes: 15\n", "    timeout-minutes: 15\n    \"runs-on\": [self-hosted]\n"),
     1, DRIFT),
    ("Harmony CI duplicate runs-on key",
     lambda t: edit(t, HW, "    timeout-minutes: 15\n", "    timeout-minutes: 15\n    runs-on: [self-hosted, linux]\n"),
     1, DRIFT),
    ("Harmony CI duplicate job key replaces the gate job",
     lambda t: (t / HW).write_text((t / HW).read_text(encoding="utf-8") +
                                   "  harmony-protocol-tests:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n",
                                   encoding="utf-8"), 1, DRIFT),
    ("Harmony CI uses pull_request_target",
     lambda t: edit(t, HW, "  pull_request:\n", "  pull_request_target:\n"), 1, DRIFT),
    ("Harmony CI without pipefail",
     lambda t: edit(t, HW, "set -euo pipefail", "set -eu"), 1, DRIFT),
    ("Harmony CI line endings changed", crlf, 1, "line endings"),
    ("Mac CI workflow missing",
     lambda t: (t / ".github/workflows/ios-tests.yml").unlink(), 1, "missing .github/workflows/ios-tests.yml"),
    ("README development entry points to an old copy",
     lambda t: edit(t, "README.md", "`~/leophone-mac` 的 `main`",
                    "`~/Documents/LeoPhoneAgent` 的 `main`"),
     1, "development entry is not"),
    ("README adds a second stale checkout path",
     lambda t: edit(t, "README.md", "## 开发 Agent 先读\n",
                    "## 开发 Agent 先读\n\n- 旧入口仍可用：`~/Documents/LeoPhoneAgent`。\n"),
     1, "non-canonical checkouts"),
    ("README duplicates the authoritative entry line",
     lambda t: edit(t, "README.md", "## 开发 Agent 先读\n",
                    "## 开发 Agent 先读\n\n- 本机唯一权威开发入口：`~/leophone-mac` 的 `main`。\n"),
     1, "exactly one"),
    ("iOS badge drifted from pbxproj",
     lambda t: regex_edit(t, "src/ios/LeoPhoneAgent.xcodeproj/project.pbxproj",
                          r"CURRENT_PROJECT_VERSION = [^;]+;", "CURRENT_PROJECT_VERSION = 99999;"),
     1, "README iOS badge"),
    ("Mac badge drifted from package.json",
     lambda t: regex_edit(t, "src/mac/leophone/package.json",
                          r'"version"\s*:\s*"[^"]+"', '"version": "9.9.9"'),
     1, "macOS source badge"),
    ("Harmony badge drifted from app.json5",
     lambda t: (regex_edit(t, "src/harmony/app/AppScope/app.json5",
                           r'"versionName"\s*:\s*"[^"]+"', '"versionName": "9.9.9"')),
     1, "HarmonyOS source badge"),
    ("Harmony catalog build drifted from app.json5",
     lambda t: regex_edit(t, "src/harmony/app/entry/src/main/ets/release/ReleaseCatalog.ets",
                          r"currentBuild:\s*number\s*=\s*\d+", "currentBuild: number = 1"),
     1, "ReleaseCatalog.currentBuild"),
    ("Android badge drifted from build.gradle.kts",
     lambda t: regex_edit(t, "src/android/app/build.gradle.kts",
                          r'versionName\s*=\s*"[^"]+"', 'versionName = "9.9.9-alpha.1"'),
     1, "README Android badge"),
    ("Harmony catalog file missing",
     lambda t: (t / "src/harmony/app/entry/src/main/ets/release/ReleaseCatalog.ets").unlink(),
     1, "missing src/harmony"),
]


def run_gate_script(checks, env_extra):
    """Render the real gate step with controlled checks and run it with bash in this repo."""
    with tempfile.TemporaryDirectory(prefix="harmony-gate-") as raw:
        script = Path(raw) / "gate.sh"
        script.write_text(harmony_ci.render_run_script(checks=checks), encoding="utf-8")
        env = dict(os.environ, **{k: v.replace("{tmp}", raw) for k, v in env_extra.items()})
        proc = subprocess.run(["bash", str(script)], cwd=ROOT, capture_output=True, text=True, env=env)
        sentinel = Path(raw) / "sentinel"
        return proc.returncode, proc.stdout + proc.stderr, sentinel.exists()


GATE_CASES = [
    # name, checks, want rc, want sentinel, required output fragments
    ("gate: all checks pass", ("true", "touch \"$GATE_SENTINEL\""), 0, True, ["first failing exit: 0"]),
    ("gate: first non-1 failure code wins, later checks still run",
     ("true", "bash -c 'exit 7'", "bash -c 'exit 3'", "touch \"$GATE_SENTINEL\""), 7, True,
     ["Check failed (exit 7)", "Check failed (exit 3)", "first failing exit: 7"]),
    ("gate: single late failure keeps its code", ("touch \"$GATE_SENTINEL\"", "bash -c 'exit 42'"), 42, True,
     ["Check failed (exit 42)"]),
    ("gate: missing command reports 127", ("leobot-no-such-command-xyz", "touch \"$GATE_SENTINEL\""), 127, True,
     ["Check failed (exit 127)"]),
]


def main():
    failures = 0
    for name, mutate, want_rc, want_text in CASES:
        with tempfile.TemporaryDirectory(prefix="entry-audit-") as raw:
            tmp = Path(raw)
            make_root(tmp)
            if mutate:
                mutate(tmp)
            proc = subprocess.run([sys.executable, str(AUDIT), "--root", str(tmp)],
                                  capture_output=True, text=True)
            out = proc.stdout + proc.stderr
            if proc.returncode == want_rc and want_text in out:
                print(f"ok   {name} (exit {proc.returncode})")
            else:
                failures += 1
                print(f"FAIL {name}: want exit {want_rc} with {want_text!r}, got {proc.returncode}")
                print("     " + out.strip().replace("\n", "\n     "))
    for name, checks, want_rc, want_sentinel, fragments in GATE_CASES:
        rc, out, sentinel = run_gate_script(checks, {"GATE_SENTINEL": "{tmp}/sentinel"})
        missing = [f for f in fragments if f not in out]
        if rc == want_rc and sentinel == want_sentinel and not missing:
            print(f"ok   {name} (exit {rc})")
        else:
            failures += 1
            print(f"FAIL {name}: want exit {want_rc} sentinel={want_sentinel}, got {rc} sentinel={sentinel}, "
                  f"missing {missing}")
            print("     " + out.strip().replace("\n", "\n     "))
    total = len(CASES) + len(GATE_CASES)
    print(f"RepositoryEntryPointAuditTests: {total - failures}/{total} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
