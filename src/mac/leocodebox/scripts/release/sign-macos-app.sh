#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:?usage: sign-macos-app.sh path/to/App.app identity}"
IDENTITY="${2:?usage: sign-macos-app.sh path/to/App.app identity}"
ENTITLEMENTS="${LEOCODEBOX_ENTITLEMENTS_PATH:-build/entitlements.mac.plist}"

if [ ! -d "$APP_PATH" ]; then
  echo "error: app bundle not found: $APP_PATH" >&2
  exit 1
fi
if [ ! -f "$ENTITLEMENTS" ]; then
  echo "error: entitlements file not found: $ENTITLEMENTS" >&2
  exit 1
fi

xattr -cr "$APP_PATH"
signed_macho=0

# Native modules and bundled CLI helpers live below Resources/app/node_modules,
# where codesign --deep does not reliably discover them. Sign every Mach-O first.
while IFS= read -r -d '' candidate; do
  description="$(file -b "$candidate")"
  if [[ "$description" != *"Mach-O"* ]]; then
    continue
  fi
  if ! output="$(codesign --force --options runtime --timestamp --sign "$IDENTITY" "$candidate" 2>&1)"; then
    echo "error: failed to sign $candidate" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  signed_macho=$((signed_macho + 1))
  if [ $((signed_macho % 25)) -eq 0 ]; then
    echo "Signed $signed_macho nested Mach-O files..."
  fi
done < <(find "$APP_PATH" -depth -type f \( -perm -111 -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0)

if [ "$signed_macho" -eq 0 ]; then
  echo "error: no Mach-O files found in $APP_PATH" >&2
  exit 1
fi

# Re-seal nested code containers after their binaries have changed, deepest first.
while IFS= read -r -d '' bundle; do
  if [ "$bundle" = "$APP_PATH" ]; then
    continue
  fi
  codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$IDENTITY" "$bundle"
done < <(find "$APP_PATH" -depth -type d \( \
  -name '*.framework' -o -name '*.app' -o -name '*.xpc' -o \
  -name '*.appex' -o -name '*.plugin' -o -name '*.bundle' \
\) -print0)

codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  --sign "$IDENTITY" "$APP_PATH"

echo "Signed $signed_macho nested Mach-O files and sealed $APP_PATH."
