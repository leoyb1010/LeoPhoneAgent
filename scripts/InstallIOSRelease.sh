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

echo "==> [1/3] 发版闸门"
"$repo_root/scripts/IOSReleaseReadinessAudit.sh"

# [T-icloud-xattr] DerivedData 绝不能落在仓库里:这个仓在 iCloud 同步盘上,
# FileProvider 会给构建产物挂 xattr,codesign 直接报 "detritus not allowed"。
derived="$HOME/Library/Developer/Xcode/DerivedData/LeoPhoneAgent-release"

if [ "$#" -gt 0 ]; then
  udids="$*"
else
  # 按 UDID 格式提取:设备名里含空格(如 "iPad Pro 13-inch"),按列取字段会
  # 抓到型号词而不是 UDID。另外 "unavailable" 里含 "available" 子串 ——
  # 不先排掉,离线的 Apple Watch 会被当成可装机目标。
  udids=$(xcrun devicectl list devices 2>/dev/null \
    | grep -i physical | grep -vi unavailable | grep -i 'available' \
    | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}')
fi
[ -n "$udids" ] || { echo "没有在线真机" >&2; exit 1; }

echo "==> [2/3] 构建 Release"
xcodebuild -project "$project" -scheme LeoPhoneAgent \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath "$derived" -allowProvisioningUpdates \
  build >/tmp/ios-install-build.log 2>&1 || {
    echo "构建失败,尾部日志:" >&2; tail -25 /tmp/ios-install-build.log >&2; exit 1; }

app=$(find "$derived/Build/Products" -maxdepth 2 -name "LeoPhoneAgent.app" -type d | head -1)
[ -n "$app" ] || { echo "没找到构建产物" >&2; exit 1; }

echo "==> [3/3] 安装"
rc=0
for u in $udids; do
  printf '    %s ... ' "$u"
  if xcrun devicectl device install app --device "$u" "$app" >/tmp/ios-install-$u.log 2>&1; then
    echo "OK"
  else
    echo "失败(见 /tmp/ios-install-$u.log)"; rc=1
  fi
done
exit $rc
