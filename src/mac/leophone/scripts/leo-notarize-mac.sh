#!/usr/bin/env bash
# [leo] 公证 + staple。凭据来自钥匙串里的 notarytool profile(leocodebox),
# 不出现在命令行、不进仓库。用法:bash scripts/leo-notarize-mac.sh <dmg>
set -euo pipefail
PROFILE="${LEO_NOTARY_PROFILE:-leocodebox}"
DMG="${1:?用法: leo-notarize-mac.sh <path/to/LeoPhoneAgent-*.dmg>}"
[ -f "$DMG" ] || { echo "找不到 DMG: $DMG" >&2; exit 1; }

# --wait 是一条长连接,代理或网络抖一下就断(HTTPClientError.connectTimeout),
# 而提交其实已经成功。所以只提交拿 ID,再用短请求轮询;中断后可带 ID 续上,不必重新上传:
#   LEO_NOTARY_SUBMISSION_ID=<id> bash scripts/leo-notarize-mac.sh <dmg>
json_field() { /usr/bin/python3 -c "import json,sys; print(json.load(sys.stdin).get('$1',''))"; }
ID="${LEO_NOTARY_SUBMISSION_ID:-}"
if [ -z "$ID" ]; then
  echo "==> 提交公证"
  ID="$(xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --no-wait --output-format json | json_field id)"
  [ -n "$ID" ] || { echo "提交公证失败:没有拿到 submission id" >&2; exit 1; }
fi
echo "    submission id: $ID"
STATUS=""
for _ in $(seq 1 120); do
  STATUS="$(xcrun notarytool info "$ID" --keychain-profile "$PROFILE" --output-format json 2>/dev/null | json_field status 2>/dev/null || true)"
  case "$STATUS" in
    Accepted) break ;;
    Invalid|Rejected)
      echo "公证未通过: $STATUS" >&2
      xcrun notarytool log "$ID" --keychain-profile "$PROFILE" >&2 || true
      exit 1 ;;
    *) sleep 15 ;;
  esac
done
[ "$STATUS" = "Accepted" ] || { echo "等待公证超时(30 分钟),稍后带 LEO_NOTARY_SUBMISSION_ID=$ID 续上" >&2; exit 1; }
echo "    status: Accepted"
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
