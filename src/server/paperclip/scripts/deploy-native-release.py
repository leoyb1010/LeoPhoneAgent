#!/usr/bin/env python3
"""Paperclip 原生（launchd）发布切换。

用法（在服务器上，以服务用户运行）：
  python3 deploy-native-release.py --root <部署根> --candidate <候选目录> [--dry-run]

流程：前置检查 → 私有数据库备份 → 建立 release/previous → 保留旧散列静态资源
→ 原子切换 release/current → 仅发送 SIGTERM，等待进程自然排空退出，由 launchd
KeepAlive 拉起新版本 → 核对健康、提交与页面哈希 → 失败则切回旧版本。

为什么不用 `launchctl bootout` / `kickstart -k`：bootout 在约 20 秒后强制
SIGKILL，服务排空偶尔超过该时长（线上曾出现 Killed: 9 与 drain 超时）；
SIGTERM 让上游的优雅关停完整执行。

脚本不打印数据库口令、Cookie 或任何环境变量值。
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

LABEL = "com.leoyuan.leophoneagent.paperclip"
DOMAIN = f"gui/{os.getuid()}"
HEALTH = "http://127.0.0.1:43871/api/health"
PSQL = "/opt/homebrew/bin/psql"
PG_DUMP = "/opt/homebrew/bin/pg_dump"


def log(msg):
    print(f"[deploy] {msg}", flush=True)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def no_proxy_open(url, timeout=5):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    # Cloudflare 会以 403 拦截 Python 默认的 "Python-urllib" User-Agent（首次上线时因此误判失败并回滚）。
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (LeoPhoneAgent deploy check)"})
    return opener.open(req, timeout=timeout)


def db_env(root):
    config = json.loads((root / "data/instances/default/config.json").read_text())
    db = urlparse(config["database"]["connectionString"])
    env = os.environ.copy()
    env["PGPASSWORD"] = db.password or ""
    args = ["-h", db.hostname or "127.0.0.1", "-p", str(db.port or 5432),
            "-U", db.username, "-d", db.path.lstrip("/"), "-w"]
    return env, args


def active_runs(root):
    env, args = db_env(root)
    out = subprocess.check_output(
        [PSQL, *args, "-Atc",
         "SELECT count(*) FROM heartbeat_runs WHERE status IN ('running','queued')"],
        env=env, text=True)
    return int(out.strip())


def service_pid():
    r = subprocess.run(["launchctl", "print", f"{DOMAIN}/{LABEL}"],
                       capture_output=True, text=True)
    for line in r.stdout.splitlines():
        line = line.strip()
        if line.startswith("pid = "):
            return int(line.split("=", 1)[1])
    return None


def health():
    try:
        with no_proxy_open(HEALTH, timeout=3) as r:
            return json.load(r)
    except OSError:
        return None


def index_hash(url):
    with no_proxy_open(url, timeout=10) as r:
        return hashlib.sha256(r.read()).hexdigest()


def swap_symlink(link, target):
    tmp = link.with_name(link.name + ".swap")
    if tmp.is_symlink() or tmp.exists():
        tmp.unlink()
    tmp.symlink_to(target)
    os.replace(tmp, link)


def graceful_restart(old_pid, wait_exit=90, wait_up=120):
    log(f"SIGTERM -> pid {old_pid}")
    subprocess.run(["launchctl", "kill", "SIGTERM", f"{DOMAIN}/{LABEL}"], check=True)
    deadline = time.time() + wait_exit
    while time.time() < deadline:
        pid = service_pid()
        if pid != old_pid:
            break
        time.sleep(1)
    else:
        # 排空超时才升级为强制重启，并如实记录。
        log("old process did not exit in time; escalating to kickstart -k")
        subprocess.run(["launchctl", "kickstart", "-k", f"{DOMAIN}/{LABEL}"], check=True)
    deadline = time.time() + wait_up
    while time.time() < deadline:
        h = health()
        pid = service_pid()
        if h and h.get("status") == "ok" and pid and pid != old_pid:
            return pid, h
        time.sleep(2)
    raise RuntimeError("service did not become healthy after restart")


def preserve_old_assets(old_release, new_release):
    old_assets = old_release / "ui/dist/assets"
    new_assets = new_release / "ui/dist/assets"
    copied = 0
    if old_assets.is_dir() and new_assets.is_dir():
        for f in old_assets.iterdir():
            dest = new_assets / f.name
            if f.is_file() and not dest.exists():
                shutil.copy2(f, dest)
                copied += 1
    return copied


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--candidate", required=True, type=Path)
    ap.add_argument("--public-url", default="")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    root = a.root.resolve()
    candidate = a.candidate.resolve()
    current = root / "release/current"
    previous = root / "release/previous"
    old_target = Path(os.readlink(current))
    old_release = old_target if old_target.is_absolute() else (current.parent / old_target)
    old_release = old_release.resolve()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    evidence = root / "backups/deploy" / f"{stamp}-{candidate.name}"

    # 前置检查：候选必须完整构建且源码已固化到 Git（无未提交改动），保证可复现与可回滚。
    for rel in ["server/dist/index.js", "ui/dist/index.html"]:
        if not (candidate / rel).is_file():
            sys.exit(f"candidate missing {rel}")
    dirty = subprocess.check_output(["git", "-C", str(candidate), "status", "--porcelain"], text=True)
    if dirty.strip():
        sys.exit("candidate has uncommitted changes; commit the generated release first")
    cand_head = subprocess.check_output(["git", "-C", str(candidate), "rev-parse", "HEAD"], text=True).strip()
    if candidate == old_release:
        sys.exit("candidate is already current")
    runs = active_runs(root)
    if runs:
        sys.exit(f"{runs} running/queued heartbeat runs; refusing to restart")
    log(f"current={old_release.name} candidate={candidate.name} head={cand_head[:12]} active_runs=0")
    if a.dry_run:
        log("dry run: checks passed")
        return

    evidence.mkdir(mode=0o700, parents=True)
    env, args = db_env(root)
    dump = evidence / "pre-deploy.dump"
    subprocess.run([PG_DUMP, *args, "-Fc", "-f", str(dump)], env=env, check=True)
    dump.chmod(0o600)
    subprocess.run(["/opt/homebrew/bin/pg_restore", "--list", str(dump)],
                   check=True, stdout=subprocess.DEVNULL)
    log(f"db dump ok ({dump.stat().st_size} bytes)")

    copied = preserve_old_assets(old_release, candidate)
    log(f"preserved {copied} old hashed assets")
    expected_index = sha256(candidate / "ui/dist/index.html")

    old_pid = service_pid()
    swap_symlink(previous, old_release)
    swap_symlink(current, candidate)
    log("release/current switched")
    report = {"timestamp": stamp, "previous": str(old_release), "current": str(candidate),
              "candidateHead": cand_head, "oldPid": old_pid, "preservedAssets": copied}
    try:
        new_pid, h = graceful_restart(old_pid)
        report.update(newPid=new_pid, health={k: h.get(k) for k in
                      ("status", "commit", "deploymentMode", "deploymentExposure",
                       "bootstrapStatus", "nativeAdapterLoginSupported")})
        loop_index = index_hash("http://127.0.0.1:43871/")
        if loop_index != expected_index:
            raise RuntimeError("loopback index hash mismatch")
        report["loopbackIndexSha256"] = loop_index
        if a.public_url:
            pub = index_hash(a.public_url.rstrip("/") + "/")
            report["publicIndexSha256"] = pub
            if pub != expected_index:
                raise RuntimeError("public index hash mismatch")
        report["passed"] = True
        log("deploy verified")
    except BaseException as exc:
        report.update(passed=False, error=str(exc))
        log(f"FAILED: {exc}; rolling back to {old_release.name}")
        swap_symlink(current, old_release)
        pid = service_pid()
        if pid:
            graceful_restart(pid)
        report["rolledBack"] = True
        raise
    finally:
        out = evidence / "deploy-report.json"
        out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        out.chmod(0o600)
        print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
