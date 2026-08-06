#!/bin/bash
# Assemble LeoAgentMac.app from the SPM executable.
#
# A desktop console needs no Xcode target — it needs a binary, an Info.plist,
# an icon, and a bundle layout. Doing it this way keeps the Mac app out of the
# iOS project's pbxproj entirely.
set -euo pipefail
cd "$(dirname "$0")"

CONFIG="${1:-release}"
APP="build/LeoAgentMac.app"

swift build -c "$CONFIG" 2>&1 | tail -3
BIN="$(swift build -c "$CONFIG" --show-bin-path)/LeoAgentMac"
[ -f "$BIN" ] || { echo "❌ 未找到可执行文件: $BIN"; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/LeoAgentMac"
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>LeoAgent</string>
  <key>CFBundleDisplayName</key><string>LeoAgent</string>
  <key>CFBundleIdentifier</key><string>com.leoyuan.leoagentmac</string>
  <key>CFBundleExecutable</key><string>LeoAgentMac</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
</dict>
</plist>
PLIST

# Ad-hoc sign so Gatekeeper lets a locally built app run.
codesign --force --deep --sign - "$APP" 2>&1 | tail -1 || true
echo "✅ $APP"
