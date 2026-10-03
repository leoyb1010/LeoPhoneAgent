#!/usr/bin/env bash
# Native hosted-macOS only. Isolated application, no product build/release/signing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REF="${1:-WORKTREE}"
LABEL="${2:-current}"
OUTPUT="${NATIVE_AUDIT_OUTPUT:-$ROOT/native-model-audit-results}/$LABEL"
BUILD="$OUTPUT/project"
mkdir -p "$OUTPUT"
python3 "$ROOT/scripts/native-model-audit/generate.py" --source-ref "$REF" --output "$BUILD"
command -v xcodegen >/dev/null || { echo 'xcodegen is required'; exit 1; }
(cd "$BUILD" && xcodegen generate)
xcodebuild -version | tee "$OUTPUT/xcode-version.txt"
xcrun simctl list devices available | tee "$OUTPUT/simulators.txt"
DESTINATION="${NATIVE_AUDIT_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5}"
set +e
xcodebuild test -project "$BUILD/NativeModelAudit.xcodeproj" -scheme NativeModelAudit \
  -destination "$DESTINATION" -parallel-testing-enabled NO \
  -resultBundlePath "$OUTPUT/NativeModelAudit.xcresult" \
  -derivedDataPath "$OUTPUT/DerivedData" CODE_SIGNING_ALLOWED=NO \
  2>&1 | tee "$OUTPUT/xcodebuild.log"
status=${PIPESTATUS[0]}
set -e
if [[ -d "$OUTPUT/NativeModelAudit.xcresult" ]]; then
  xcrun xcresulttool export attachments --path "$OUTPUT/NativeModelAudit.xcresult" \
    --output-path "$OUTPUT/attachments" || true
  xcrun xcresulttool get test-results summary --path "$OUTPUT/NativeModelAudit.xcresult" \
    --format json > "$OUTPUT/test-summary.json" || true
fi
cp "$BUILD/source-manifest.json" "$OUTPUT/source-manifest.json"
# Build intermediates are large and carry no review evidence.
rm -rf "$OUTPUT/DerivedData"
exit "$status"
