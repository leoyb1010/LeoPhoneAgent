#!/bin/zsh
# LeoBot Mac 机群部署:校验 → 安装 → 健康检查(进程 + 版本 + 连上中继)→ 失败自动回滚。
#
#   scripts/leo-deploy-mac.sh <dmg> <host>[,<host>...]      # host 用 fleet ssh 别名:mbp studio mini air
#   scripts/leo-deploy-mac.sh <dmg> studio,mini,air --no-keepalive
#
# 宿主机(studio / mini / air)默认同时安装 com.leoyuan.leobot-keepalive 常驻守护;mbp 不装。
# 中继在线判定读 mini 上中继 0.2.2 写的 ~/.leoagent/relay-status.json。
#
# 传输走增量:远端先把已装的 LeoBot.app 以 APFS 克隆(秒级、不占空间)放进暂存目录,再把新 .app
# rsync 上去 —— 只传变了的文件 / 块。以前每台都整包传 255 MB 的 DMG,Air 走香港中转约 70 KB/s 要一个小时。
# 完整性靠 codesign --verify --deep --strict(签名封住包内每个文件)+ Gatekeeper 公证评估,任何字节不对都过不去。
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
MNT=$(hdiutil attach -nobrowse -readonly "$DMG" | awk '/\/Volumes\//{print substr($0, index($0,"/Volumes/"))}')
[[ -d "$MNT/LeoBot.app" ]] || { echo "DMG 里没有 LeoBot.app" >&2; exit 2; }
trap 'hdiutil detach "$MNT" -quiet 2>/dev/null' EXIT
STAGE=/tmp/LeoBot-$V.stage

relay_has() {   # relay_has <relay-name> <version> → 0 表示该 Mac 以该版本连在中继上
  ssh -o BatchMode=yes -o ConnectTimeout=8 mini "cat ~/.leoagent/relay-status.json 2>/dev/null" | \
    /usr/bin/python3 -c "import json,sys;d=json.load(sys.stdin);sys.exit(0 if any(m['name']=='$1' and m.get('app_version')=='$2' for m in d.get('machines',[])) else 1)" 2>/dev/null
}

for h in ${(s:,:)HOSTS}; do
  echo "\n== $h"
  ka=$KEEPALIVE; [[ $h == mbp ]] && ka=0
  # 暂存目录不存在就用已装版本克隆一份当增量基准(没装过就从空目录开始,等于全量)
  ssh -o BatchMode=yes "$h" "mkdir -p $STAGE; [ -d $STAGE/LeoBot.app ] || { [ -d /Applications/LeoBot.app ] && cp -Rc /Applications/LeoBot.app $STAGE/LeoBot.app; }; true" || { echo "  ✗ 连不上"; fail+=$h; continue; }
  # LEO_DEPLOY_DMG_URL:远端自己从 URL(如 GitHub Release)下载同一个 DMG,校验 sha256 后解进暂存目录,
  # 下面的 rsync 就几乎不用传。Air 走香港中转 ~70 KB/s,直连 GitHub ~3.9 MB/s。下载或校验失败就退回增量 rsync。
  if [[ -n "${LEO_DEPLOY_DMG_URL:-}" ]]; then
    pre=$(ssh -o BatchMode=yes "$h" "U='$LEO_DEPLOY_DMG_URL' SUM=$SUM STAGE=$STAGE zsh -s" <<'PREFETCH'
f=$STAGE/download.dmg
curl -fsSL --retry 3 -o $f "$U" || { echo "download-failed"; exit 0; }
[ "$(shasum -a 256 $f | awk '{print $1}')" = "$SUM" ] || { echo "sha-mismatch"; rm -f $f; exit 0; }
M=$(hdiutil attach -nobrowse -readonly $f | awk '/\/Volumes\//{print substr($0, index($0,"/Volumes/"))}')
rm -rf $STAGE/LeoBot.app && ditto "$M/LeoBot.app" $STAGE/LeoBot.app; hdiutil detach "$M" -quiet; rm -f $f
echo "prefetched"
PREFETCH
)
    echo "  URL 预取:$pre"
  fi
  sent=1
  for try in 1 2 3 4 5; do
    stats=$(rsync -a --delete --stats -e "ssh -o BatchMode=yes -o ServerAliveInterval=15" "$MNT/LeoBot.app/" "$h:$STAGE/LeoBot.app/" 2>&1) && { sent=0; break; }
    echo "  传输中断,重试 $try:$(echo "$stats" | grep -v -i -E "^(total|file list|literal|matched|sent|number)" | tail -2 | tr '\n' ' ')"; sleep 5
  done
  (( sent == 0 )) || { echo "  ✗ 传输失败"; fail+=$h; continue; }
  echo "$stats" | grep -i -E "^(literal data|matched data|total transferred file size|total bytes sent)" | sed 's/^/  /'
  (( ka )) && scp -q "$HERE/fleet/com.leoyuan.leobot-keepalive.plist" "$h:/tmp/com.leoyuan.leobot-keepalive.plist"
  out=$(ssh -o BatchMode=yes "$h" "V=$V STAGE=$STAGE KA=$ka zsh -s" <<'REMOTE'
set -u
staged=$STAGE/LeoBot.app
# 增量拼出来的包必须和签名一字不差,再过一遍公证评估;不对就不动线上版本
codesign --verify --deep --strict "$staged" 2>/dev/null || { echo "RESULT staged-signature-invalid"; rm -rf "$STAGE"; exit 1; }
spctl -a --type exec "$staged" 2>/dev/null || { echo "RESULT staged-gatekeeper-rejected"; rm -rf "$STAGE"; exit 1; }
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
  # 用户上次主动退出留下的标记会让常驻守护不拉起;部署就是要它跑起来,先清掉。
  rm -f ~/.leoagent/leobot-user-quit
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
# 新版启动会改写 CLI 配置(1.15.x 把 leo-treasury / leo-brain 写成 1.14.x 严格 schema 不认的 MCP 条目,
# 回滚后旧版会把这两条静默删掉)。装之前存一份放在旧版存档旁边,两条回滚路径都还原它。
cfg=~/.leophoneagent/cli/config.json; cfg_snap=""
# 不用 cp -p:存档按 mtime 清理,快照的 mtime 得是存的时刻;配置里有密钥,umask 077。
if [ -n "$archived" ] && [ -f "$cfg" ]; then cfg_snap=${archived%.app}.cli-config.json; ( umask 077 && cp "$cfg" "$cfg_snap" ) || cfg_snap=""; fi
mv "$staged" /Applications/LeoBot.app; rm -rf "$STAGE"
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
    [ -n "$cfg_snap" ] && cp -p "$cfg_snap" "$cfg"
    launch_gui; echo "RESULT rolled-back-to $old"
  else
    # 全新机器没有可回滚的旧版:装坏了就是失败,不能报「installed」。
    echo "RESULT failed-no-archive"
  fi
  exit 1
fi
# 旧版存档只留最近 3 份(每份约 700 MB,不清理时每台已堆到 4–10 GB)
ls -dt ~/LeoBot-archives/LeoBot-*-replaced-*.app 2>/dev/null | tail -n +4 | while read -r d; do rm -rf "$d"; done
ls -t ~/LeoBot-archives 2>/dev/null | grep -E '^LeoBot-.*-replaced-.*\.cli-config\.json$' | tail -n +4 | while read -r f; do rm -f ~/LeoBot-archives/"$f"; done
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
      snap=${archived%.app}.cli-config.json   # 安装前存的 CLI 配置(远端脚本里同名),有就还原
      # 先卸常驻守护:不然 pkill 到 rm 之间它会把新版又拉起来,回滚后跑的还是新版。
      [[ -n $archived ]] && ssh -o BatchMode=yes "$h" "uid=\$(id -u); p=~/Library/LaunchAgents/com.leoyuan.leobot-keepalive.plist; launchctl bootout gui/\$uid/com.leoyuan.leobot-keepalive 2>/dev/null; pkill -x LeoBot; rm -f ~/.leoagent/leobot-user-quit; for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -xq LeoBot || break; sleep 1; done; rm -rf /Applications/LeoBot.app; mv '$archived' /Applications/LeoBot.app; [ -f '$snap' ] && cp -p '$snap' ~/.leophoneagent/cli/config.json; [ -f \$p ] && launchctl bootstrap gui/\$uid \$p 2>/dev/null; for l in com.leoyuan.leobot-keepalive com.leoyuan.leophoneagent-app; do launchctl print gui/\$uid/\$l >/dev/null 2>&1 && launchctl kickstart gui/\$uid/\$l && break; done; true" && echo "  已回滚"
      fail+=$h
    fi
  fi
done

echo
if (( ${#fail} )); then echo "失败:${fail[*]}"; exit 1; fi
echo "全部成功:$HOSTS → $V"
