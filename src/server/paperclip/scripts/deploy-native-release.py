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
import re
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


def fetch_index(url):
    with no_proxy_open(url, timeout=10) as r:
        return r.read(), dict(r.headers.items())


# Cloudflare Web Analytics 会在边缘向 HTML 注入 beacon 脚本；比对公网页面前去掉这一段，其余内容须逐字节一致。
CF_BEACON = re.compile(rb'<script[^>]*static\.cloudflareinsights\.com/beacon[^>]*>\s*</script>\s*')


def strip_edge_injection(body):
    return CF_BEACON.sub(b"", body)


def index_hash(url):
    return hashlib.sha256(fetch_index(url)[0]).hexdigest()


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


SKILL_SCAN_SKIP = {"Library", "node_modules", ".Trash", ".git", ".cache", ".npm", ".pnpm-store"}


def repoint_managed_skill_links(root, release, home=None, max_depth=5):
    """把各 CLI 技能目录里指向本部署根旧版本 `<发布目录>/skills/<名称>` 的链接改指到 release。

    为什么需要：Paperclip 把技能以软链接装进 ~/.hermes/skills、~/.claude/skills 等目录，链接指向
    当时发布目录的物理路径。切换版本后旧目录仍保留（用于回滚），上游 Hermes 适配器发现链接指向
    另一个仍存在的目录时视为"他人安装"而拒绝启动（Cannot reconcile Hermes skill ... occupied），
    其他 CLI 则静默读取旧版技能。只处理目标位于部署根内某个发布目录的 skills 子路径下的链接；
    用户自己安装的技能（目标不在部署根内）不动。返回 [(link, old, new)]。
    """
    home = Path(home or os.path.expanduser("~"))
    root = Path(root).resolve()
    release = Path(release).resolve()
    changed = []

    def walk(directory, depth):
        try:
            entries = list(os.scandir(directory))
        except OSError:
            return
        for e in entries:
            if e.name in SKILL_SCAN_SKIP:
                continue
            if e.is_symlink():
                if "skill" not in str(Path(e.path).parent).lower():
                    continue
                raw = os.readlink(e.path)
                target = Path(raw if os.path.isabs(raw) else os.path.join(directory, raw))
                target = Path(os.path.normpath(target))
                try:
                    rel = target.relative_to(root)
                except ValueError:
                    continue
                parts = rel.parts
                # 链接所在的旧发布目录 = 部署根下最近的、带 .git 的祖先（发布候选都是 Git 工作区）；
                # 保留它在发布目录内的相对路径（如 skills/paperclip 或
                # server/dist/onboarding-assets/first-task/skills/first-task），换到新发布目录下。
                rest = None
                for k in range(1, min(3, len(parts) - 1) + 1):
                    if (root.joinpath(*parts[:k]) / ".git").exists():
                        rest = parts[k:]
                        break
                if not rest or "skills" not in rest[:-1]:
                    continue
                desired = release.joinpath(*rest)
                if target == desired or not desired.is_dir():
                    continue
                tmp = Path(e.path + ".paperclip-swap")
                if tmp.is_symlink() or tmp.exists():
                    tmp.unlink()
                tmp.symlink_to(desired)
                os.replace(tmp, e.path)
                changed.append((e.path, str(target), str(desired)))
            elif depth < max_depth and e.is_dir(follow_symlinks=False):
                walk(e.path, depth + 1)

    walk(home, 0)
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, type=Path)
    ap.add_argument("--candidate", required=True, type=Path)
    ap.add_argument("--public-url", default="")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--repoint-skills-only", action="store_true",
                    help="只把各 CLI 技能目录中指向旧版本的 Paperclip 技能链接改指到 release/current")
    a = ap.parse_args()
    if a.repoint_skills_only:
        current_release = (a.root / "release/current").resolve()
        for link, old_t, new_t in repoint_managed_skill_links(a.root, current_release):
            log(f"skill link repointed: {link}: {old_t} -> {new_t}")
        log("skill links checked")
        return

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
    skill_links = repoint_managed_skill_links(root, candidate)
    for link, _, _ in skill_links:
        log(f"skill link repointed: {link}")
    report = {"timestamp": stamp, "previous": str(old_release), "current": str(candidate),
              "candidateHead": cand_head, "oldPid": old_pid, "preservedAssets": copied,
              "repointedSkillLinks": [link for link, _, _ in skill_links]}
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
            body, headers = fetch_index(a.public_url.rstrip("/") + "/")
            report["publicIndexSha256"] = hashlib.sha256(body).hexdigest()
            report["publicEdgeInjectionStripped"] = strip_edge_injection(body) != body
            pub = hashlib.sha256(strip_edge_injection(body)).hexdigest()
            expected_stripped = hashlib.sha256(
                strip_edge_injection((candidate / "ui/dist/index.html").read_bytes())).hexdigest()
            if pub != expected_stripped:
                # 保存两份页面与公网响应头，便于判断是边缘改写还是服务端按域名注入。
                (evidence / "public-index.html").write_bytes(body)
                (evidence / "public-index.headers.json").write_text(json.dumps(headers, indent=2))
                loop_body, loop_headers = fetch_index("http://127.0.0.1:43871/")
                (evidence / "loopback-index.html").write_bytes(loop_body)
                (evidence / "loopback-index.headers.json").write_text(json.dumps(loop_headers, indent=2))
                raise RuntimeError("public index hash mismatch")
        report["passed"] = True
        log("deploy verified")
    except BaseException as exc:
        report.update(passed=False, error=str(exc))
        log(f"FAILED: {exc}; rolling back to {old_release.name}")
        swap_symlink(current, old_release)
        repoint_managed_skill_links(root, old_release)
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
