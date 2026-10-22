#!/bin/zsh
# LeoBot Mac 机群部署:校验 → 安装 → 健康检查(进程 + 版本 + 连上中继)→ 失败自动回滚。
#
#   scripts/leo-deploy-mac.sh <dmg> <host>[,<host>...]      # host 用 fleet ssh 别名:mbp studio mini air
#   scripts/leo-deploy-mac.sh <dmg> studio,mini,air --no-keepalive
#
# 宿主机(studio / mini / air)默认同时安装 com.leoyuan.leobot-keepalive 常驻守护;mbp 不装。
# 中继在线判定读 mini 上中继 0.2.2 写的 ~/.leoagent/relay-status.json。
set -uo pipefail
DMG=${1:?usage: leo-deploy-mac.sh <dmg> <host,...> [--no-keepalive]}
HOSTS=${2:?usage: leo-deploy-mac.sh <dmg> <host,...> [--no-keepalive]}
KEEPALIVE=1; [[ "${3:-}" == "--no-keepalive" ]] && KEEPALIVE=0
HERE=${0:A:h}
typeset -A RELAY_NAME=(mbp LeoyuandeMacBook-Pro-2 studio LeoMac-Studio-2 mini LeodeMac-mini-2 air LeoyuanAir)

[[ -f "$DMG" ]] || { echo "没有这个 DMG: $DMG" >&2; exit 2; }
V=$(basename "$DMG" | sed -E 's/LeoBot-([0-9.]+)-.*/\1/')
SUM=$(shasum -a 256 "$DMG" | awk '{print $1}')
echo "LeoBot $V  sha256 ${SUM[1,16]}…"
fail=()

relay_has() {   # relay_has <relay-name> <version> → 0 表示该 Mac 以该版本连在中继上
  ssh -o BatchMode=yes -o ConnectTimeout=8 mini "cat ~/.leoagent/relay-status.json 2>/dev/null" | \
    /usr/bin/python3 -c "import json,sys;d=json.load(sys.stdin);sys.exit(0 if any(m['name']=='$1' and m.get('app_version')=='$2' for m in d.get('machines',[])) else 1)" 2>/dev/null
}

for h in ${(s:,:)HOSTS}; do
  echo "\n== $h"
  ka=$KEEPALIVE; [[ $h == mbp ]] && ka=0
  rsync -a --partial --inplace -e "ssh -o BatchMode=yes" "$DMG" "$h:/tmp/LeoBot-$V.dmg" || { echo "  ✗ 传输失败"; fail+=$h; continue; }
  (( ka )) && scp -q "$HERE/fleet/com.leoyuan.leobot-keepalive.plist" "$h:/tmp/com.leoyuan.leobot-keepalive.plist"
  out=$(ssh -o BatchMode=yes "$h" "V=$V SUM=$SUM KA=$ka zsh -s" <<'REMOTE'
set -u
dmg=/tmp/LeoBot-$V.dmg
[ "$(shasum -a 256 $dmg | awk '{print $1}')" = "$SUM" ] || { echo "RESULT sha-mismatch"; exit 1; }
ts=$(date +%Y%m%d%H%M)
old=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" /Applications/LeoBot.app/Contents/Info.plist 2>/dev/null || echo none)
uid=$(id -u); ka_plist=~/Library/LaunchAgents/com.leoyuan.leobot-keepalive.plist
launchctl bootout gui/$uid/com.leoyuan.leobot-keepalive 2>/dev/null   # 装的时候别被它拉起旧版
# 不管从哪条路退出(成功、回滚、出错),常驻守护都要装回去:以前回滚路径直接 exit,那台 Mac 就没人看着了。
restore_keepalive() {
  if [ "$KA" = 1 ] && [ -f /tmp/com.leoyuan.leobot-keepalive.plist ]; then
    mv /tmp/com.leoyuan.leobot-keepalive.plist "$ka_plist"
  fi
  [ -f "$ka_plist" ] && launchctl bootstrap gui/$uid "$ka_plist" 2>/dev/null
  return 0
}
trap restore_keepalive EXIT
# 绝不能在 ssh 会话里直接 open:那样起来的 LeoBot 读不到系统语言(界面变英文),
# 也不在登录会话里,够不着登录钥匙串(弹「找不到用于存储…的钥匙串」)。2026-10-22 实际踩过。
# 改为让登录会话(gui 域)里的 launchd 任务去拉起:宿主机用常驻守护,MBP 用登录项任务。
launch_gui() {
  restore_keepalive
  for l in com.leoyuan.leobot-keepalive com.leoyuan.leophoneagent-app; do
    if launchctl print gui/$uid/$l >/dev/null 2>&1; then
      launchctl kickstart gui/$uid/$l && return 0
    fi
  done
  echo "warn-no-gui-agent"; open -g -a /Applications/LeoBot.app
}
osascript -e 'tell application "LeoBot" to quit' 2>/dev/null
for i in {1..30}; do pgrep -xq LeoBot || break; sleep 1; done
pgrep -xq LeoBot && pkill -x LeoBot && sleep 2
mkdir -p ~/LeoBot-archives; archived=""
if [ -d /Applications/LeoBot.app ]; then archived=~/LeoBot-archives/LeoBot-$old-replaced-$ts.app; mv /Applications/LeoBot.app "$archived"; fi
M=$(hdiutil attach -nobrowse -readonly $dmg | awk '/\/Volumes\//{print substr($0, index($0,"/Volumes/"))}')
ditto "$M/LeoBot.app" /Applications/LeoBot.app; hdiutil detach "$M" -quiet; rm -f $dmg
ok=1
spctl -a --type exec /Applications/LeoBot.app 2>/dev/null || { echo "gatekeeper-rejected"; ok=0; }
new=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" /Applications/LeoBot.app/Contents/Info.plist 2>/dev/null)
[ "$new" = "$V" ] || { echo "version-mismatch $new"; ok=0; }
if [ $ok = 1 ]; then
  launch_gui
  for i in {1..45}; do pgrep -xq LeoBot && break; sleep 2; done
  pgrep -xq LeoBot || { echo "not-running"; ok=0; }
fi
if [ $ok = 0 ]; then
  if [ -n "$archived" ]; then
    pkill -x LeoBot 2>/dev/null; sleep 2; rm -rf /Applications/LeoBot.app; mv "$archived" /Applications/LeoBot.app
    launch_gui; echo "RESULT rolled-back-to $old"
  else
    # 全新机器没有可回滚的旧版:装坏了就是失败,不能报「installed」。
    echo "RESULT failed-no-archive"
  fi
  exit 1
fi
echo "RESULT installed $V (was $old) archived=$archived"
REMOTE
)
  rc=$?
  echo "$out" | sed 's/^/  /'
  (( rc == 0 )) || { echo "  ✗ $h 安装失败"; fail+=$h; continue; }
  # 健康检查:90 秒内要以新版本连上中继
  name=${RELAY_NAME[$h]:-}
  if [[ -n $name ]]; then
    for i in {1..18}; do relay_has "$name" "$V" && break; sleep 5; done
    if relay_has "$name" "$V"; then echo "  ✓ $name 已以 $V 连上中继"
    else
      echo "  ✗ 90 秒内没以 $V 连上中继,回滚"
      archived=$(echo "$out" | sed -n 's/.*archived=\(.*\)$/\1/p')
      # 先卸常驻守护:不然 pkill 到 rm 之间它会把新版又拉起来,回滚后跑的还是新版。
      [[ -n $archived ]] && ssh -o BatchMode=yes "$h" "uid=\$(id -u); p=~/Library/LaunchAgents/com.leoyuan.leobot-keepalive.plist; launchctl bootout gui/\$uid/com.leoyuan.leobot-keepalive 2>/dev/null; pkill -x LeoBot; for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq LeoBot || break; sleep 1; done; rm -rf /Applications/LeoBot.app; mv '$archived' /Applications/LeoBot.app; [ -f \$p ] && launchctl bootstrap gui/\$uid \$p 2>/dev/null; for l in com.leoyuan.leobot-keepalive com.leoyuan.leophoneagent-app; do launchctl print gui/\$uid/\$l >/dev/null 2>&1 && launchctl kickstart gui/\$uid/\$l && break; done; true" && echo "  已回滚"
      fail+=$h
    fi
  fi
done

echo
if (( ${#fail} )); then echo "失败:${fail[*]}"; exit 1; fi
echo "全部成功:$HOSTS → $V"
