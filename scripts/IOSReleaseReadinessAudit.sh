#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project="$repo_root/src/ios/LeoPhoneAgent.xcodeproj/project.pbxproj"
catalog="$repo_root/src/ios/Views/Settings/LeoReleaseNotesView.swift"
app="$repo_root/src/ios/MinisApp.swift"
expected_version=${1:-1.1.2}
expected_build=${2:-25}

escaped_version=$(printf '%s' "$expected_version" | sed 's/\./\\./g')
version_count=$(rg -c "MARKETING_VERSION = ${escaped_version};" "$project")
build_count=$(rg -c "CURRENT_PROJECT_VERSION = ${expected_build};" "$project")

# [T-ci-honest-green] 不硬编码"12":target 数会随扩展/Widget 增减(现在
# 是 14)。真正要保证的是"所有 MARKETING_VERSION 都等于期望版本",
# 也就是:期望版本的出现次数 == 全部 MARKETING_VERSION 声明的总数。
# 硬编码一个具体数字,只会让每次加 target 后发布脚本假性失败。
total_version_lines=$(rg -c "MARKETING_VERSION = " "$project")
total_build_lines=$(rg -c "CURRENT_PROJECT_VERSION = " "$project")
[ "$version_count" -eq "$total_version_lines" ] || {
  echo "有 target 的版本号不是 $expected_version:$version_count/$total_version_lines 个匹配" >&2
  exit 1
}
[ "$build_count" -eq "$total_build_lines" ] || {
  echo "有 target 的 build 号不是 $expected_build:$build_count/$total_build_lines 个匹配" >&2
  exit 1
}

rg -q "version: \"${escaped_version}\"" "$catalog"
rg -q 'releases\.first \{ \$0\.version == currentVersion \}' "$catalog"
rg -q 'lastPresentedReleaseVersion != currentVersion' "$app"
rg -q 'lastPresentedReleaseVersion = LeoReleaseCatalog\.currentVersion' "$app"
rg -q '\.interactiveDismissDisabled\(\)' "$app"

if rg -q 'com\.openminis|PRODUCT_BUNDLE_IDENTIFIER = .*minisapp' "$project"; then
  echo "legacy product identifier remains in release build settings" >&2
  exit 1
fi

echo "IOSReleaseReadinessAudit: $expected_version ($expected_build), release prompt, and product identifiers passed"
