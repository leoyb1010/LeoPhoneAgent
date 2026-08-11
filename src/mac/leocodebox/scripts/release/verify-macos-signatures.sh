#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:?usage: verify-macos-signatures.sh path/to/App.app}"

if [ ! -d "$APP_PATH" ]; then
  echo "error: app bundle not found: $APP_PATH" >&2
  exit 1
fi

checked=0
failures=0

while IFS= read -r -d '' candidate; do
  description="$(file -b "$candidate")"
  if [[ "$description" != *"Mach-O"* ]]; then
    continue
  fi

  checked=$((checked + 1))
  if ! codesign --verify --strict "$candidate" 2>/dev/null; then
    echo "error: invalid signature: $candidate" >&2
    failures=$((failures + 1))
    continue
  fi

  details="$(codesign -dv --verbose=2 "$candidate" 2>&1)"
  if [[ "$details" != *"Authority=Developer ID Application"* ]]; then
    echo "error: missing Developer ID signature: $candidate" >&2
    failures=$((failures + 1))
  fi
  if [[ "$details" != *"Timestamp="* ]]; then
    echo "error: missing secure timestamp: $candidate" >&2
    failures=$((failures + 1))
  fi
  if [[ "$details" != *"runtime"* ]]; then
    echo "error: hardened runtime is disabled: $candidate" >&2
    failures=$((failures + 1))
  fi
done < <(find "$APP_PATH" -type f \( -perm -111 -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0)

if [ "$checked" -eq 0 ]; then
  echo "error: no Mach-O files found in $APP_PATH" >&2
  exit 1
fi
if [ "$failures" -ne 0 ]; then
  echo "error: $failures nested macOS signature checks failed" >&2
  exit 1
fi

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
echo "Verified $checked nested Mach-O signatures."
