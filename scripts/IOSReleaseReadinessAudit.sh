#!/bin/sh
set -eu

# 发版闸门:版本号统一 + 「本次更新」弹窗链路完整 + 产品标识干净。
#
# [T-gate-on-real-path] 只用 POSIX grep,不依赖 ripgrep。
# 血的教训:这脚本原来通篇 rg,而本机 /bin/sh 的 PATH 里没有 rg —— 本地跑
# 直接 127 退出。CI 里有 brew install ripgrep 所以一直是绿的,于是"闸门存在"
# 的错觉维持了很久,真实发版(本地 xcodebuild 直装真机)从来没被它挡过一次。
# 闸门必须能在开发者真正走的那条路上跑起来,否则等于没有。

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project="$repo_root/src/ios/LeoPhoneAgent.xcodeproj/project.pbxproj"
catalog="$repo_root/src/ios/Views/Settings/LeoReleaseNotesView.swift"
app="$repo_root/src/ios/MinisApp.swift"

for f in "$project" "$catalog" "$app"; do
  [ -f "$f" ] || { echo "缺文件:$f" >&2; exit 1; }
done

detected_version=$(sed -n 's/.*MARKETING_VERSION = \([^;]*\);/\1/p' "$project" | head -n 1)
detected_build=$(sed -n 's/.*CURRENT_PROJECT_VERSION = \([^;]*\);/\1/p' "$project" | head -n 1)
expected_version=${1:-$detected_version}
expected_build=${2:-$detected_build}

# grep -c 无匹配时退出码为 1,set -e 下会直接终止且不给上下文,统一兜 0。
count() { grep -c -F -- "$1" "$2" 2>/dev/null || echo 0; }

version_count=$(count "MARKETING_VERSION = ${expected_version};" "$project")
build_count=$(count "CURRENT_PROJECT_VERSION = ${expected_build};" "$project")

# [T-ci-honest-green] 不硬编码 target 数:它会随扩展/Widget 增减。要保证的是
# "所有 MARKETING_VERSION 都等于期望版本",即期望版本出现次数 == 声明总数。
total_version_lines=$(count "MARKETING_VERSION = " "$project")
total_build_lines=$(count "CURRENT_PROJECT_VERSION = " "$project")
[ "$version_count" -eq "$total_version_lines" ] || {
  echo "有 target 的版本号不是 $expected_version:$version_count/$total_version_lines 个匹配" >&2
  exit 1
}
[ "$build_count" -eq "$total_build_lines" ] || {
  echo "有 target 的 build 号不是 $expected_build:$build_count/$total_build_lines 个匹配" >&2
  exit 1
}

# 铁律核心:这一版必须有自己的更新记录条目,不能拿上一版顶上。
grep -q -F -- "version: \"${expected_version}\"" "$catalog" || {
  echo "更新记录缺 $expected_version 的条目 —— 装机后弹不出「本次更新」。" >&2
  echo "去 src/ios/Views/Settings/LeoReleaseNotesView.swift 的 releases 最前面补一条。" >&2
  exit 1
}

# 弹窗链路的四个环节,少一个都会让"记录写了但弹不出来"。
for pat in \
  'releases.first { $0.version == currentVersion }' \
  'lastPresentedReleaseVersion != currentVersion' \
  'lastPresentedReleaseVersion = LeoReleaseCatalog.currentVersion' \
; do
  f="$catalog"
  case "$pat" in lastPresented*) f="$app" ;; esac
  grep -q -F -- "$pat" "$f" || { echo "弹窗链路断了,缺:$pat($f)" >&2; exit 1; }
done
grep -q -F -- '.interactiveDismissDisabled()' "$app" || {
  echo "更新弹窗没锁交互关闭 —— 启动时的自动聚焦可能把它直接消掉。" >&2; exit 1
}

if grep -q -E 'com\.openminis|PRODUCT_BUNDLE_IDENTIFIER = .*minisapp' "$project"; then
  echo "legacy product identifier remains in release build settings" >&2
  exit 1
fi

echo "IOSReleaseReadinessAudit: $expected_version ($expected_build), release prompt, and product identifiers passed"
