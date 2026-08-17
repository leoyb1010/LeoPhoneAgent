#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <standard.apk> <power.apk>" >&2
  exit 64
fi

sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
if [[ -z "$sdk_root" ]]; then
  echo "ANDROID_SDK_ROOT or ANDROID_HOME is required" >&2
  exit 64
fi

apksigner="$(find "$sdk_root/build-tools" -type f -name apksigner | sort -V | tail -1)"
aapt="$(find "$sdk_root/build-tools" -type f -name aapt | sort -V | tail -1)"
if [[ -z "$apksigner" || -z "$aapt" ]]; then
  echo "Android build-tools with aapt and apksigner are required" >&2
  exit 69
fi

expected_signer="f325bc65f4f6ba456938c7d88c96ad2ef418197d1204cfd2bd881aa145bf11df"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
gradle_file="$repo_root/src/android/app/build.gradle.kts"
expected_code="$(sed -nE 's/^[[:space:]]*versionCode = ([0-9]+).*$/\1/p' "$gradle_file" | head -1)"
expected_version="$(sed -nE 's/^[[:space:]]*versionName = "([^"]+)".*$/\1/p' "$gradle_file" | head -1)"
if [[ -z "$expected_code" || -z "$expected_version" ]]; then
  echo "could not read Android version from $gradle_file" >&2
  exit 65
fi

verify_apk() {
  local apk="$1"
  local expected_package="$2"
  local expected_name="$3"
  local badging signer

  "$apksigner" verify "$apk"
  badging="$("$aapt" dump badging "$apk" | head -1)"
  [[ "$badging" == *"name='$expected_package'"* ]] || { echo "wrong package: $badging" >&2; exit 65; }
  [[ "$badging" == *"versionCode='$expected_code'"* ]] || { echo "wrong versionCode: $badging" >&2; exit 65; }
  [[ "$badging" == *"versionName='$expected_name'"* ]] || { echo "wrong versionName: $badging" >&2; exit 65; }

  signer="$("$apksigner" verify --print-certs "$apk" | sed -n 's/^.*certificate SHA-256 digest: //p' | head -1)"
  [[ "$signer" == "$expected_signer" ]] || {
    echo "wrong signer for $apk: $signer" >&2
    echo "expected alpha upgrade signer: $expected_signer" >&2
    exit 66
  }

  shasum -a 256 "$apk"
}

verify_apk "$1" "com.leoyuan.leophoneagent" "$expected_version"
verify_apk "$2" "com.leoyuan.leophoneagent.power" "$expected_version-power"
