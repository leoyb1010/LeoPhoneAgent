#!/usr/bin/env bash
#
# Notarize + staple a signed leocodebox DMG using a keychain-stored notarytool
# profile, so Apple credentials never appear on the command line or in the repo.
#
# One-time setup (you run this yourself; the password is typed into your Terminal
# and stored in the login keychain — it is never passed through any tool):
#
#   xcrun notarytool store-credentials "leocodebox" \
#     --apple-id "YOUR_APPLE_ID@example.com" \
#     --team-id  "YOUR_TEAM_ID" \
#     --password "APP_SPECIFIC_PASSWORD"   # from appleid.apple.com
#
# Then:  npm run desktop:notarize:mac [path/to/leocodebox-*.dmg]
#
set -euo pipefail

PROFILE="${LEOCODEBOX_NOTARY_PROFILE:-leocodebox}"
DMG="${1:-release/desktop/leocodebox-$(node -p "require('./package.json').version")-mac-arm64.dmg}"

if [ ! -f "$DMG" ]; then
  echo "error: DMG not found: $DMG" >&2
  echo "build a signed DMG first:  LEOCODEBOX_SIGN_IDENTITY=\"Developer ID Application: NAME (TEAM)\" npm run desktop:dist:mac:signed" >&2
  exit 1
fi

MOUNT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/leocodebox-notary.XXXXXX")"
STAPLE_ROOT=""
cleanup() {
  if [ -n "$MOUNT_DIR" ]; then
    hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || true
    rmdir "$MOUNT_DIR" 2>/dev/null || true
    MOUNT_DIR=""
  fi
  if [ -n "$STAPLE_ROOT" ]; then
    rm -rf "$STAPLE_ROOT"
  fi
}
trap cleanup EXIT

echo "==> Verifying the Developer ID signature inside the DMG"
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_DIR" "$DMG" >/dev/null
APP_PATH="$(find "$MOUNT_DIR" -maxdepth 1 -type d -name '*.app' -print -quit)"
if [ -z "$APP_PATH" ]; then
  echo "error: no app bundle found in $DMG" >&2
  exit 1
fi
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
SIGNATURE_DETAILS="$(codesign -dv --verbose=2 "$APP_PATH" 2>&1)"
printf '%s\n' "$SIGNATURE_DETAILS"
if ! grep -qi "Authority=Developer ID Application" <<<"$SIGNATURE_DETAILS"; then
  echo "error: app is not signed with a Developer ID Application certificate: $APP_PATH" >&2
  exit 1
fi
hdiutil detach "$MOUNT_DIR" -quiet
rmdir "$MOUNT_DIR"
MOUNT_DIR=""

echo "==> Submitting to Apple notary service (profile: $PROFILE). This can take several minutes."
SUBMISSION_JSON="$(xcrun notarytool submit "$DMG" \
  --keychain-profile "$PROFILE" \
  --wait \
  --output-format json)"
printf '%s\n' "$SUBMISSION_JSON"
SUBMISSION_ID="$(printf '%s' "$SUBMISSION_JSON" | plutil -extract id raw -o - -)"
SUBMISSION_STATUS="$(printf '%s' "$SUBMISSION_JSON" | plutil -extract status raw -o - -)"
if [ "$SUBMISSION_STATUS" != "Accepted" ]; then
  echo "error: Apple notarization status is $SUBMISSION_STATUS" >&2
  xcrun notarytool log "$SUBMISSION_ID" --keychain-profile "$PROFILE" || true
  exit 1
fi

echo "==> Stapling the notarization ticket into the DMG"
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"

echo "==> Stapling the notarized app and rebuilding updater artifacts"
STAPLE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/leocodebox-app-staple.XXXXXX")"
STAPLED_APP="$STAPLE_ROOT/leocodebox.app"
MOUNT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/leocodebox-app-source.XXXXXX")"
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_DIR" "$DMG" >/dev/null
APP_PATH="$(find "$MOUNT_DIR" -maxdepth 1 -type d -name '*.app' -print -quit)"
if [ -z "$APP_PATH" ]; then
  echo "error: no app bundle found in notarized $DMG" >&2
  exit 1
fi
ditto --norsrc --noqtn "$APP_PATH" "$STAPLED_APP"
hdiutil detach "$MOUNT_DIR" -quiet
rmdir "$MOUNT_DIR"
MOUNT_DIR=""
xcrun stapler staple "$STAPLED_APP"
xcrun stapler validate "$STAPLED_APP"
codesign --verify --deep --strict --verbose=2 "$STAPLED_APP"
spctl -a -vvv --type execute "$STAPLED_APP"
node scripts/release/finalize-notarized-mac-artifacts.js "$STAPLED_APP"

echo "==> Rebuilding the DMG with the stapled app"
DMG_IMAGE="$STAPLE_ROOT/image"
REBUILT_DMG="$STAPLE_ROOT/$(basename "$DMG")"
mkdir -p "$DMG_IMAGE"
ditto --norsrc --noqtn "$STAPLED_APP" "$DMG_IMAGE/leocodebox.app"
ln -s /Applications "$DMG_IMAGE/Applications"
bash scripts/release/create-macos-dmg.sh "$DMG_IMAGE" "$REBUILT_DMG"
mv -f "$REBUILT_DMG" "$DMG"

echo "==> Notarizing the final DMG that contains the stapled app"
FINAL_SUBMISSION_JSON="$(xcrun notarytool submit "$DMG" \
  --keychain-profile "$PROFILE" \
  --wait \
  --output-format json)"
printf '%s\n' "$FINAL_SUBMISSION_JSON"
FINAL_SUBMISSION_ID="$(printf '%s' "$FINAL_SUBMISSION_JSON" | plutil -extract id raw -o - -)"
FINAL_SUBMISSION_STATUS="$(printf '%s' "$FINAL_SUBMISSION_JSON" | plutil -extract status raw -o - -)"
if [ "$FINAL_SUBMISSION_STATUS" != "Accepted" ]; then
  echo "error: final Apple notarization status is $FINAL_SUBMISSION_STATUS" >&2
  xcrun notarytool log "$FINAL_SUBMISSION_ID" --keychain-profile "$PROFILE" || true
  exit 1
fi
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
rm -rf "$STAPLE_ROOT"
STAPLE_ROOT=""

echo "==> Gatekeeper assessment"
MOUNT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/leocodebox-gatekeeper.XXXXXX")"
hdiutil attach -readonly -nobrowse -mountpoint "$MOUNT_DIR" "$DMG" >/dev/null
APP_PATH="$(find "$MOUNT_DIR" -maxdepth 1 -type d -name '*.app' -print -quit)"
if [ -z "$APP_PATH" ]; then
  echo "error: no app bundle found in notarized $DMG" >&2
  exit 1
fi
spctl -a -vvv --type execute "$APP_PATH"
xcrun stapler validate "$APP_PATH"
hdiutil detach "$MOUNT_DIR" -quiet
rmdir "$MOUNT_DIR"
MOUNT_DIR=""

echo "Done: $DMG is signed, notarized, and stapled."
