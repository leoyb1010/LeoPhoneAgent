#!/bin/sh
set -eu

# iOS 真机装机的唯一入口。用法:
#   ./scripts/InstallIOSRelease.sh              # 装到所有在线真机
#   ./scripts/InstallIOSRelease.sh <UDID> ...   # 装到指定设备
#
# [T-gate-on-real-path] 闸门焊在第一步:更新记录漏写就装不进去。
# 血的教训:IOSReleaseReadinessAudit 以前只挂在 .github/workflows/ios-tests.yml,
# 而真实发版是本地 xcodebuild 直装真机 —— 闸门存在,却不在开发者真正走的那条
# 路上,于是"版本 bump 了但弹不出更新"能一路溜到用户手机上。

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project="$repo_root/src/ios/LeoPhoneAgent.xcodeproj"

echo "==> [1/4] 发版闸门"
"$repo_root/scripts/IOSReleaseReadinessAudit.sh"

# [T-icloud-xattr] DerivedData 绝不能落在仓库里:这个仓在 iCloud 同步盘上,
# FileProvider 会给构建产物挂 xattr,codesign 直接报 "detritus not allowed"。
derived="$HOME/Library/Developer/Xcode/DerivedData/LeoPhoneAgent-release"

if [ "$#" -gt 0 ]; then
  udids="$*"
else
  # 按 UDID 格式提取(新机型是 8-16 位:00008160-00084DCE3C200036;旧的是 8-4-4-4-12):设备名里含空格(如 "iPad Pro 13-inch"),按列取字段会
  # 抓到型号词而不是 UDID。另外 "unavailable" 里含 "available" 子串 ——
  # 不先排掉,离线的 Apple Watch 会被当成可装机目标。在线状态可能显示为 available (paired) 或 connected,两种都算。
  udids=$(xcrun devicectl list devices 2>/dev/null \
    | grep -i physical | grep -vi unavailable | grep -iE 'available|connected' \
    | grep -oE '[0-9A-Fa-f]{8}-([0-9A-Fa-f]{16}|[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})')
fi
[ -n "$udids" ] || { echo "没有在线真机" >&2; exit 1; }

# [up-p0-gates] 性能预算闸门:装新版前,先从目标 iPhone/iPad 拉"当前已装版本"的 perf.jsonl
# 和最新日志跑 IOSPerfBudgetGate。超预算就挡住(本次是性能修复时用 LEO_PERF_GATE=warn 显式放行);
# 拉不到数据会打印 "SKIPPED: no perf data",不会静默通过。
echo "==> [2/4] 性能预算闸门"
devices_now=$(xcrun devicectl list devices 2>/dev/null || true)
perf_udid=""
for u in $udids; do
  if ! printf '%s\n' "$devices_now" | grep "$u" | grep -qi 'Watch'; then perf_udid="$u"; break; fi
done
"$repo_root/scripts/IOSPerfGateFromDevice.sh" $perf_udid

# 指定一台新设备时，让 Xcode 为实际设备更新描述文件；generic 目标不会注册新机。
build_destination='generic/platform=iOS'
if [ "$#" -eq 1 ]; then
  build_destination="id=$1"
fi

echo "==> [3/4] 构建 Release"
xcodebuild -project "$project" -scheme LeoPhoneAgent \
  -configuration Release -destination "$build_destination" \
  -derivedDataPath "$derived" -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  build >/tmp/ios-install-build.log 2>&1 || {
    echo "构建失败,尾部日志:" >&2; tail -25 /tmp/ios-install-build.log >&2; exit 1; }

app="$derived/Build/Products/Release-iphoneos/LeoPhoneAgent.app"
[ -d "$app" ] || { echo "没找到 Release 真机构建产物" >&2; exit 1; }
codesign --verify --deep --strict "$app" || exit 1

# [WP-46] 归档 dSYM:真机崩溃报告只能用同一次构建的 dSYM 符号化。2026-10-17 取证时本机只剩
# 1.74 的,一份 1.71 的真崩溃(SIGSEGV 在 JSC 线程)因此无法定位。失败不挡装机。
ver=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Info.plist" 2>/dev/null || echo unknown)
bld=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Info.plist" 2>/dev/null || echo 0)
dsym_dir="$HOME/Library/Developer/LeoBot-dSYMs/$ver-$bld"
if mkdir -p "$dsym_dir"; then
  find "$derived/Build/Products/Release-iphoneos" -maxdepth 4 -name '*.dSYM' -type d 2>/dev/null | while read -r d; do
    ditto "$d" "$dsym_dir/$(basename "$d")" 2>/dev/null || true
  done
  echo "    dSYM → $dsym_dir ($(ls "$dsym_dir" 2>/dev/null | wc -l | tr -d ' ') 个)"
fi

# Apple Watch 装内嵌的手表 App(只装 iPhone 不会可靠地带上手表)。
# 在线的配对手表总是一起装;它们不在命令行参数里也会补上。
watch_app=$(ls -d "$app"/Watch/*.app 2>/dev/null | head -1 || true)
devices=$(xcrun devicectl list devices 2>/dev/null || true)
# 手表那一行 Reality 列是空的(不写 physical),按 physical 过滤会把在线手表漏掉;改为排除模拟器。
watch_udids=$(printf '%s\n' "$devices" | grep -vi simulated | grep -vi unavailable | grep -iE 'available|connected' | grep -i 'Watch' \
  | grep -oE '[0-9A-Fa-f]{8}-([0-9A-Fa-f]{16}|[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})' || true)
if [ -n "$watch_app" ]; then
  for w in $watch_udids; do
    case " $udids " in *" $w "*) ;; *) udids="$udids $w" ;; esac
  done
fi

echo "==> [4/4] 安装"
rc=0
for u in $udids; do
  printf '    %s ... ' "$u"
  target="$app"
  if printf '%s\n' "$devices" | grep "$u" | grep -qi 'Watch'; then
    [ -n "$watch_app" ] || { echo "跳过(构建里没有手表 App)"; continue; }
    target="$watch_app"
  fi
  if xcrun devicectl device install app --device "$u" "$target" >/tmp/ios-install-$u.log 2>&1; then
    echo "OK"
  else
    echo "失败(见 /tmp/ios-install-$u.log)"; rc=1
  fi
done
exit $rc
