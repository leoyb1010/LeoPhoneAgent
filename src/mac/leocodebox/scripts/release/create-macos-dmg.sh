#!/bin/bash
set -euo pipefail

SOURCE_DIR="${1:?source directory is required}"
OUTPUT_DMG="${2:?output dmg is required}"
VOLUME_NAME="${LEOCODEBOX_DMG_VOLUME_NAME:-leocodebox}"
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BACKGROUND_SOURCE="${LEOCODEBOX_DMG_BACKGROUND:-$ROOT_DIR/electron/assets/dmg-background-light.png}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/leocodebox-dmg-layout.XXXXXX")"
RW_DMG="$WORK_DIR/layout.dmg"
MOUNT_DIR=""

cleanup() {
  if [ -n "$MOUNT_DIR" ]; then
    hdiutil detach "$MOUNT_DIR" -quiet 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$SOURCE_DIR/.background"
if [ -f "$BACKGROUND_SOURCE" ]; then
  # Finder backgrounds use logical pixels. Keep the high-resolution source in
  # the design archive and create the 660x400 installer surface here.
  sips -z 400 660 "$BACKGROUND_SOURCE" --out "$SOURCE_DIR/.background/background.png" >/dev/null
fi

SIZE_MB=$(( $(du -sm "$SOURCE_DIR" | awk '{print $1}') + 220 ))
hdiutil create -quiet -volname "$VOLUME_NAME" -srcfolder "$SOURCE_DIR" -ov -format UDRW -size "${SIZE_MB}m" "$RW_DMG"
ATTACH_OUTPUT="$(hdiutil attach -readwrite -noverify -noautoopen "$RW_DMG")"
MOUNT_DIR="$(printf '%s\n' "$ATTACH_OUTPUT" | awk '/\/Volumes\// {sub(/^.*\/Volumes\//,"/Volumes/"); print; exit}')"
if [ -z "$MOUNT_DIR" ]; then
  echo "error: failed to locate mounted DMG volume" >&2
  printf '%s\n' "$ATTACH_OUTPUT" >&2
  exit 1
fi

if [ -f "$MOUNT_DIR/.background/background.png" ]; then
  chflags hidden "$MOUNT_DIR/.background" 2>/dev/null || true
  osascript <<APPLESCRIPT
tell application "Finder"
  open POSIX file "$MOUNT_DIR"
  delay 1
  tell disk "$VOLUME_NAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set pathbar visible of container window to false
    set bounds of container window to {120, 120, 780, 520}
    set theViewOptions to icon view options of container window
    set arrangement of theViewOptions to not arranged
    set icon size of theViewOptions to 96
    set text size of theViewOptions to 12
    set background picture of theViewOptions to file ".background:background.png"
    set position of item "leocodebox.app" of container window to {175, 205}
    set position of item "Applications" of container window to {485, 205}
    close
    open
    update without registering applications
    delay 2
    close
  end tell
end tell
APPLESCRIPT
fi

sync
hdiutil detach "$MOUNT_DIR" -quiet
MOUNT_DIR=""
rm -f "$OUTPUT_DMG"
hdiutil convert -quiet "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$OUTPUT_DMG"
hdiutil verify "$OUTPUT_DMG"
