#!/usr/bin/env python3
"""LeoBot 机群巡检(只读,只用标准库)。

两种用法:
  巡检模式(mini 上 LaunchAgent,每 5 分钟):
    LeoFleetDoctor.py --monitor STATE_DIR --expect LeoMac-Studio-2,LeodeMac-mini-2,...
    查中继 /relay/health、中继写的 relay-status.json(哪些 Mac 的 LeoBot 连着)、排队积压、
    ~/.leoagent 备份新鲜度、磁盘余量。状态由好变坏 / 由坏变好时发 ntfy(NTFY_URL、NTFY_TOKEN_FILE,
    与 BrainGatewayContractCheck 同一条通道)。一台 Mac 要连续两轮不在线才报,部署重启不误报。
  机群模式(在任意一台 Mac 上手动跑):
    LeoFleetDoctor.py --fleet mbp,studio,mini,air
    逐台 ssh 查 LeoBot 版本 / 主进程 / 常驻守护,再从 mini 读中继的在线表,打一张表。
退出码:0 全部正常,1 有异常。
"""
import argparse, json, os, re, shutil, subprocess, sys, time, urllib.request
from datetime import datetime, timezone

LEOAGENT = os.path.expanduser("~/.leoagent")
RELAY_HEALTH = "http://127.0.0.1:8650/relay/health"
# ssh 别名 → 中继里的机器名(ssh 配置见 ~/.ssh/config.d/fleet-hosts.conf)
FLEET_NAMES = {"mbp": "LeoyuandeMacBook-Pro-2", "studio": "LeoMac-Studio-2",
               "mini": "LeodeMac-mini-2", "air": "LeoyuanAir"}
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # 回环请求绝不走代理


def check_relay():
    try:
        body = json.loads(NO_PROXY.open(RELAY_HEALTH, timeout=5).read())
        return body.get("status") == "ok", f"中继 {body.get('version')} · {body.get('machines')} 台在线"
    except Exception as e:  # noqa: BLE001
        return False, f"中继 /relay/health 不通:{e}"


def relay_status():
    try:
        with open(os.path.join(LEOAGENT, "relay-status.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def check_backup(max_age_h):
    """restic 仓库在 LEO_RELAY_RESTIC_REPO,密码文件 LEO_RELAY_RESTIC_PASSWORD_FILE;没配就跳过。"""
    repo, pw = os.environ.get("LEO_RELAY_RESTIC_REPO"), os.environ.get("LEO_RELAY_RESTIC_PASSWORD_FILE")
    restic = shutil.which("restic") or "/opt/homebrew/bin/restic"
    if not repo or not pw:
        return True, "备份检查未配置(跳过)"
    try:
        out = subprocess.run([restic, "-r", repo, "--password-file", pw, "snapshots", "--json",
                              "--tag", "leo-relay", "--latest", "1"], capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return False, "restic 60 秒没响应(外接盘未挂载或无访问授权?)"
    if out.returncode != 0:
        return False, f"restic 读不出快照:{out.stderr.strip()[:160]}"
    snaps = json.loads(out.stdout or "[]")
    if not snaps:
        return False, "没有 ~/.leoagent 的备份快照"
    # restic 给纳秒;老 Python 的 fromisoformat 只认到微秒
    stamp = re.sub(r"(\.\d{6})\d+", r"\1", snaps[-1]["time"].replace("Z", "+00:00"))
    taken = datetime.fromisoformat(stamp)
    age_h = (datetime.now(timezone.utc) - taken).total_seconds() / 3600
    return age_h <= max_age_h, f"最近备份 {age_h:.1f} 小时前"


def check_disk(min_free_pct):
    usage = shutil.disk_usage("/")
    free = usage.free * 100 / usage.total
    return free >= min_free_pct, f"磁盘剩余 {free:.0f}%"


def notify(title, body, bad):
    url, token_file = os.environ.get("NTFY_URL"), os.environ.get("NTFY_TOKEN_FILE")
    if not url:
        return
    req = urllib.request.Request(url, data=body.encode(), method="POST")
    req.add_header("Title", title.encode("utf-8").decode("latin-1"))
    req.add_header("Tags", "rotating_light" if bad else "white_check_mark")
    if bad:
        req.add_header("Priority", "high")
    if token_file and os.path.isfile(token_file):
        req.add_header("Authorization", "Bearer " + open(token_file).read().strip())
    try:
        NO_PROXY.open(req, timeout=8).read()
    except Exception as e:  # noqa: BLE001
        print(f"ntfy 发送失败:{e}", file=sys.stderr)


def monitor(a):
    state_dir = os.path.expanduser(a.monitor)
    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    last_path = os.path.join(state_dir, "last.json")
    try:
        prev = json.load(open(last_path))
    except (OSError, ValueError):
        prev = {}
    results = {}
    results["relay"] = check_relay()
    status = relay_status() or {}
    online = {m["name"]: m for m in status.get("machines", [])}
    misses = prev.get("misses", {})
    for name in [n for n in a.expect.split(",") if n]:
        if name in online:
            misses[name] = 0
            results[f"mac:{name}"] = (True, f"{name} 在线 · {online[name].get('app_version') or '?'}")
        else:
            misses[name] = misses.get(name, 0) + 1
            # 连续两轮(约 10 分钟)不在线才算坏:部署 / 重启不误报
            results[f"mac:{name}"] = (misses[name] < 2, f"{name} 的 LeoBot 不在中继上(连续 {misses[name]} 轮)")
    queued = sum((status.get("queued") or {}).values())
    results["queue"] = (queued < 50, f"中继排队 {queued} 条")
    results["backup"] = check_backup(a.backup_max_age_h)
    results["disk"] = check_disk(10)

    bad_now = sorted(k for k, (ok, _) in results.items() if not ok)
    bad_before = sorted(prev.get("bad", []))
    newly_bad = [k for k in bad_now if k not in bad_before]
    recovered = [k for k in bad_before if k not in bad_now]
    for k, (ok, detail) in results.items():
        print(f"{'PASS' if ok else 'FAIL'}  {k:<32} {detail}")
    if newly_bad:
        notify("LeoBot 机群异常", "\n".join(results[k][1] for k in newly_bad), True)
    if recovered:
        notify("LeoBot 机群恢复", "\n".join(f"{k} 已恢复" for k in recovered), False)
    json.dump({"at": time.time(), "bad": bad_now, "misses": misses,
               "results": {k: {"ok": ok, "detail": d} for k, (ok, d) in results.items()}},
              open(last_path, "w"), ensure_ascii=False, indent=1)
    return 0 if not bad_now else 1


def ssh(host, cmd, timeout=25):
    try:
        out = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, cmd],
                             capture_output=True, text=True, timeout=timeout)
        return out.returncode, out.stdout.strip()
    except subprocess.TimeoutExpired:
        return 124, ""


def fleet(a):
    probe = ("v=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "
             "/Applications/LeoBot.app/Contents/Info.plist 2>/dev/null || echo none); "
             "pgrep -xq LeoBot && r=yes || r=no; "
             "launchctl print gui/$(id -u)/com.leoyuan.leobot-keepalive >/dev/null 2>&1 && k=yes || k=no; "
             "echo \"$v $r $k\"")
    rc, raw = ssh("mini", f"cat {LEOAGENT}/relay-status.json 2>/dev/null || cat ~/.leoagent/relay-status.json")
    try:
        online = {m["name"] for m in json.loads(raw).get("machines", [])}
    except ValueError:
        online = None
    ok_all = online is not None
    print(f"{'主机':<8}{'版本':<10}{'主进程':<8}{'常驻守护':<10}中继在线")
    for host in [h for h in a.fleet.split(",") if h]:
        rc, out = ssh(host, probe)
        version, running, keep = (out.split() + ["?", "?", "?"])[:3] if rc == 0 else ("不可达", "?", "?")
        relay = "?" if online is None else ("是" if FLEET_NAMES.get(host) in online else "否")
        ok = rc == 0 and running == "yes" and relay != "否"
        ok_all &= ok
        print(f"{host:<8}{version:<10}{running:<8}{keep:<10}{relay}{'' if ok else '   ← 异常'}")
    if online is None:
        print("读不到 mini 上的 relay-status.json(中继 0.2.2 起才有)")
    return 0 if ok_all else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--monitor", metavar="STATE_DIR")
    # MBP 是随身笔记本,合盖离线是常态,默认不盯;常开的三台才是"宿主"
    ap.add_argument("--expect", default=",".join(v for k, v in FLEET_NAMES.items() if k != "mbp"),
                    help="应当在线的中继机器名,逗号分隔")
    ap.add_argument("--backup-max-age-h", type=float, default=26)
    ap.add_argument("--fleet", metavar="HOSTS", help="ssh 别名,逗号分隔,如 mbp,studio,mini,air")
    a = ap.parse_args()
    if a.fleet:
        return fleet(a)
    if a.monitor:
        return monitor(a)
    ap.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
