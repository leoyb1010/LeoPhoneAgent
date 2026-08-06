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

[ "$version_count" -eq 12 ] || {
  echo "expected 12 target/config version entries for $expected_version; found $version_count" >&2
  exit 1
}
[ "$build_count" -eq 12 ] || {
  echo "expected 12 target/config build entries for $expected_build; found $build_count" >&2
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
