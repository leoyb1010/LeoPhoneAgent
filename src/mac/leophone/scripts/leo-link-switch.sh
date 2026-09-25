#!/bin/zsh
# [leo-link] 把"手机经中继连这台 Mac"从 Python leoagent 切到 LeoPhoneAgent 桥接,或者切回去。
#
#   scripts/leo-link-switch.sh            切换:备份 leoagent 的 plist → 去掉中继地址与中继钥匙
#                                         (它就不再注册中继)→ 重载 → 打开桥接开关
#   scripts/leo-link-switch.sh --rollback 回滚:关桥接开关(App 15 秒内让出机器名)→ 恢复 plist 备份 → 重载
#   scripts/leo-link-switch.sh --status   只看现状
#
# 钥匙不打印、不进命令行参数:plist 用 Python plistlib 就地改。
# leoagent 继续在 127.0.0.1:8646 跑 claude / codex / grok,桥接用它现在的本机钥匙转给它。
# 这一步不换 leoagent 的钥匙:手机可能还经 Tailscale(:8647)直连它;钥匙拆分随中继 0.2 轮换一起做。
set -euo pipefail

LABEL=com.leoyuan.leoagent
PLIST=~/Library/LaunchAgents/$LABEL.plist
HOME_DIR=${LEOAGENT_HOME:-~/.leoagent}
SWITCH=$HOME_DIR/link.json
DOMAIN=gui/$(id -u)

status() {
  python3 - "$PLIST" "$SWITCH" <<'PY'
import json, os, plistlib, sys
plist, switch = sys.argv[1], sys.argv[2]
env = plistlib.load(open(plist, "rb")).get("EnvironmentVariables", {}) if os.path.exists(plist) else {}
enabled = False
if os.path.exists(switch):
    try: enabled = json.load(open(switch)).get("enabled") is True
    except Exception: pass
print("leoagent 注册中继:", "是" if env.get("LEOAGENT_RELAY_URL") else "否")
print("桥接开关 link.json:", "开" if enabled else "关")
PY
}

has_relay() {
  python3 - "$1" <<'PY'
import plistlib, sys
env = plistlib.load(open(sys.argv[1], "rb")).get("EnvironmentVariables", {})
sys.exit(0 if env.get("LEOAGENT_RELAY_URL") else 1)
PY
}

reload_leoagent() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  # bootout 是异步的:旧实例没卸干净就 bootstrap 会报 "5: Input/output error"。等它消失,再重试几次。
  for _ in {1..20}; do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 0.5
  done
  local loaded=0
  for _ in {1..5}; do
    if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then loaded=1; break; fi
    sleep 1
  done
  [[ $loaded == 1 ]] || { echo "launchctl bootstrap 失败:$PLIST" >&2; return 1; }
  for _ in {1..40}; do
    curl -fsS -m 2 http://127.0.0.1:8646/health >/dev/null 2>&1 && { echo "leoagent 已重载,8646 正常"; return 0; }
    sleep 0.5
  done
  echo "leoagent 重载后 20 秒内没起来,请检查 $HOME_DIR/server.err" >&2
  return 1
}

# 中继 0.2 把机器名钉在桥接领到的专属钥匙上:回滚前先解钉,不然 leoagent 回来一直被拒(4003 名字已钉)。
# 钥匙在 Python 里从钥匙串读出、放进请求头,不上命令行。
unpin_machine() {
  python3 - "$1" <<'PY' || echo "解钉没成功;leoagent 若一直连不上中继,到中继上解除这台机器的钉扎" >&2
import json, os, plistlib, re, socket, subprocess, sys, urllib.error, urllib.parse, urllib.request
env = plistlib.load(open(sys.argv[1], "rb")).get("EnvironmentVariables", {})
name = os.environ.get("LEOAGENT_RELAY_NAME", "").strip() or socket.gethostname().split(".")[0]
account = re.sub(r"[^A-Za-z0-9._-]", "_", name) or "mac"
key = subprocess.run(["/usr/bin/security", "find-generic-password", "-s", "com.leoyuan.leophoneagent.link",
                      "-a", account, "-w"], capture_output=True, text=True).stdout.strip()
if not key:
    print("桥接没领过机器专属钥匙,不用解钉")
    sys.exit(0)
base = re.sub(r"/relay/agent$", "", env["LEOAGENT_RELAY_URL"].strip().rstrip("/"))
base = base.replace("wss://", "https://").replace("ws://", "http://")
req = urllib.request.Request(f"{base}/relay/api/machines/{urllib.parse.quote(name)}/unpin", data=b"{}",
                             method="POST", headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        print("已解除机器名钉扎:", json.load(resp).get("ok"))
except urllib.error.HTTPError as error:
    if error.code == 404:
        print("中继还是 0.1,没有钉扎")
    else:
        raise
PY
}

case "${1:-}" in
  --status)
    status
    ;;
  --rollback)
    # 只认还带中继地址的备份:连着切换两次时,较新的备份可能已经是切换后的版本。
    backup=""
    for candidate in $(ls -t "$PLIST".bak-link-* 2>/dev/null); do
      if has_relay "$candidate"; then backup=$candidate; break; fi
    done
    [[ -n "$backup" ]] || { echo "找不到带中继地址的 plist 备份($PLIST.bak-link-*),不动任何东西" >&2; exit 1; }
    umask 077
    print '{"enabled": false}' > "$SWITCH"
    echo "桥接开关已关,等 App 让出机器名…"
    sleep 20
    unpin_machine "$backup"
    cp "$backup" "$PLIST"
    echo "已恢复 $backup"
    if ! reload_leoagent; then
      # leoagent 起不来就把机器名还给桥接,手机至少还有一条路。
      print '{"enabled": true}' > "$SWITCH"
      echo "leoagent 没起来,已重新打开桥接开关" >&2
      exit 1
    fi
    status
    ;;
  "")
    [[ -f "$PLIST" ]] || { echo "没有 $PLIST" >&2; exit 1; }
    umask 077
    if ! has_relay "$PLIST"; then
      # 已经切换过:不再备份(否则备份的是没有中继地址的版本,回滚时就回不去了),只确保桥接开着。
      print '{"enabled": true}' > "$SWITCH"
      echo "已经切换过了:leoagent 不注册中继,桥接开关已开"
      status
      exit 0
    fi
    ts=$(date +%Y%m%d%H%M%S)
    cp "$PLIST" "$PLIST.bak-link-$ts"
    echo "已备份 → $PLIST.bak-link-$ts"
    python3 - "$PLIST" <<'PY'
import plistlib, sys
path = sys.argv[1]
data = plistlib.load(open(path, "rb"))
env = data.setdefault("EnvironmentVariables", {})
env.pop("LEOAGENT_RELAY_URL", None)
env.pop("LEOAGENT_RELAY_KEY", None)
plistlib.dump(data, open(path, "wb"))
PY
    if ! reload_leoagent; then
      # 改完 leoagent 起不来:恢复原 plist 让它照旧注册中继,桥接不开,手机走原来的路。
      cp "$PLIST.bak-link-$ts" "$PLIST"
      reload_leoagent || true
      echo "切换失败,已恢复原来的 leoagent 配置" >&2
      exit 1
    fi
    print '{"enabled": true}' > "$SWITCH"
    echo "桥接开关已开:LeoPhoneAgent 15 秒内接管中继连接"
    status
    ;;
  *)
    echo "用法:$0 [--status|--rollback]" >&2
    exit 2
    ;;
esac
