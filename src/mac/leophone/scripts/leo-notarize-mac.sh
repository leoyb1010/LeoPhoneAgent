#!/usr/bin/env bash
# [leo] 公证 + staple。凭据来自钥匙串里的 notarytool profile(leocodebox),
# 不出现在命令行、不进仓库。用法:bash scripts/leo-notarize-mac.sh <dmg>
set -euo pipefail
PROFILE="${LEO_NOTARY_PROFILE:-leocodebox}"
DMG="${1:?用法: leo-notarize-mac.sh <path/to/LeoPhoneAgent-*.dmg>}"
[ -f "$DMG" ] || { echo "找不到 DMG: $DMG" >&2; exit 1; }

echo "==> 提交公证(几分钟)"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
echo "==> staple DMG"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

MNT="$(mktemp -d "${TMPDIR:-/tmp}/leo-notary.XXXXXX")"
hdiutil attach -readonly -nobrowse -mountpoint "$MNT" "$DMG" >/dev/null
APP="$(ls -d "$MNT"/*.app | head -1)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/leo-staple.XXXXXX")"
ditto "$APP" "$STAGE/$(basename "$APP")"
hdiutil detach "$MNT" -quiet; rmdir "$MNT" 2>/dev/null || true

echo "==> staple app 并重建 zip"
xcrun stapler staple "$STAGE/$(basename "$APP")"
xcrun stapler validate "$STAGE/$(basename "$APP")"
DIST="$(dirname "$DMG")"
ZIP="${DIST}/$(basename "${DMG%.dmg}").zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$STAGE/$(basename "$APP")" "$ZIP"
echo "==> Gatekeeper 评估"
spctl -a -t exec -vv "$STAGE/$(basename "$APP")"
rm -rf "$STAGE"
echo "==> 完成: $DMG 与 $ZIP 均已公证并 staple"
