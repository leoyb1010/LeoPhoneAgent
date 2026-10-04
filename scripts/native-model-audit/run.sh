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
cp "$BUILD/source-manifest.json" "$OUTPUT/source-manifest.json"
if [[ "$REF" == "WORKTREE" ]]; then
  # Parse the COMPLETE changed production source, including the real singleton
  # store. This is syntax-only, explicitly not a full-app SDK typecheck/build.
  echo 'Syntax-only Swift parse of actual production provider source; not a product build' | tee "$OUTPUT/source-syntax.log"
  xcrun swiftc -frontend -parse -swift-version 5 \
    "$ROOT/src/ios/Providers/ProviderConfigStore.swift" \
    "$ROOT/src/ios/Providers/ProviderConfigDB.swift" \
    "$ROOT/src/ios/Providers/ModelCatalog.swift" \
    "$ROOT/src/ios/Providers/ModelEntry.swift" \
    "$ROOT/src/ios/Providers/ModelSwitcher.swift" \
    "$ROOT/src/ios/Providers/ModelPinStore.swift" \
    2>&1 | tee -a "$OUTPUT/source-syntax.log"
fi
command -v xcodegen >/dev/null || { echo 'xcodegen is required'; exit 1; }
(cd "$BUILD" && xcodegen generate)
xcodebuild -version | tee "$OUTPUT/xcode-version.txt"
xcrun simctl list devices available | tee "$OUTPUT/simulators.txt"
DESTINATION="${NATIVE_AUDIT_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5}"
# macOS ships Bash 3.2: expanding an empty array under nounset raises an error.
# Explicit full targets preserve the current suite while avoiding that edge case.
TEST_SCOPE=("-only-testing:NativeModelAuditTests" "-only-testing:NativeModelAuditUITests")
if [[ "$LABEL" == "baseline" ]]; then
  # Baseline is immutable visual/codec evidence, not a claim that old behavior
  # satisfies newly introduced interaction contracts. Earlier full-run results
  # remain separate GitHub artifacts; failures here still propagate unchanged.
  TEST_SCOPE=("-only-testing:NativeModelAuditTests/AuditCodecTests")
  for test in \
    test01QuickPickerAndLargeCatalogSearch \
    test02FullPickerSearchAndEmptyResults \
    test03ModelGroupsAndGroupDetail \
    test04ProviderCatalogNativeRows \
    test05AccessibilityTextSizeAndEmptyCatalog \
    test18ChineseNativeScreens; do
    TEST_SCOPE+=("-only-testing:NativeModelAuditUITests/NativeModelJourneys/$test")
  done
  printf '%s\n' 'Immutable baseline: native screenshot journeys and codec tests only. Historical interaction failures are retained in earlier run artifacts, not repaired in baseline production source.' > "$OUTPUT/test-scope.txt"
else
  printf '%s\n' 'Current production source: full native interaction, codec, catalog and SQLite test suites.' > "$OUTPUT/test-scope.txt"
fi
run_native_tests() {
  local bundle="$1" log="$2"
  shift 2
  xcodebuild test -project "$BUILD/NativeModelAudit.xcodeproj" -scheme NativeModelAudit \
    -destination "$DESTINATION" -parallel-testing-enabled NO \
    -test-timeouts-enabled YES -default-test-execution-time-allowance 120 -maximum-test-execution-time-allowance 180 \
    "$@" -resultBundlePath "$bundle" \
    -derivedDataPath "$OUTPUT/DerivedData" CODE_SIGNING_ALLOWED=NO \
    2>&1 | tee "$log"
  local result=${PIPESTATUS[0]}
  return "$result"
}
export_native_result() {
  local bundle="$1" folder="$2"
  if [[ -d "$bundle" ]]; then
    xcrun xcresulttool export attachments --path "$bundle" --output-path "$folder/attachments" || true
    xcrun xcresulttool get test-results summary --path "$bundle" --format json > "$folder/test-summary.json" || true
  fi
  python3 "$ROOT/scripts/native-model-audit/export_images.py" "$folder"
}
preflight_status=0
if [[ "$REF" == "WORKTREE" ]]; then
  # Keep reproduced UI regressions separate, reusing the same project and build.
  # The complete suite runs after either outcome; a preflight failure stays red.
  mkdir -p "$OUTPUT/preflight"
  PREFLIGHT=(
    "-only-testing:NativeModelAuditUITests/NativeModelJourneys/test01QuickPickerAndLargeCatalogSearch"
    "-only-testing:NativeModelAuditUITests/NativeModelJourneys/test05AccessibilityTextSizeAndEmptyCatalog"
    "-only-testing:NativeModelAuditUITests/NativeModelJourneys/test13CatalogBulkHideShowKeepsFavoritesGroupsAndDefault"
    "-only-testing:NativeModelAuditUITests/NativeModelJourneys/test20FavoriteEditDragPersistsOrder"
    "-only-testing:NativeModelAuditUITests/NativeModelJourneys/test21ReturningFromGroupManagementKeepsPickerOpen"
    "-only-testing:NativeModelAuditUITests/NativeModelJourneys/test22RejectedGroupSaveKeepsSelectionAndAllowsRetry"
    "-only-testing:NativeModelAuditUITests/NativeModelJourneys/test23ActualEditorRetainsAliasAfterRejectedSaveAndRetry"
  )
  if run_native_tests "$OUTPUT/preflight/NativeModelAudit.xcresult" "$OUTPUT/preflight/xcodebuild.log" "${PREFLIGHT[@]}"; then
    export_native_result "$OUTPUT/preflight/NativeModelAudit.xcresult" "$OUTPUT/preflight"
  else
    preflight_status=$?
    export_native_result "$OUTPUT/preflight/NativeModelAudit.xcresult" "$OUTPUT/preflight"
    printf '%s\n' 'Preflight failed; original evidence is retained. The full current unit/UI suites still run for comprehensive coverage. Aggregate status remains failed even if the full suite passes.' > "$OUTPUT/test-scope.txt"
  fi
fi
set +e
run_native_tests "$OUTPUT/NativeModelAudit.xcresult" "$OUTPUT/xcodebuild.log" "${TEST_SCOPE[@]}"
status=$?
set -e
export_native_result "$OUTPUT/NativeModelAudit.xcresult" "$OUTPUT"
cp "$BUILD/source-manifest.json" "$OUTPUT/source-manifest.json"
# Build intermediates are large and carry no review evidence.
rm -rf "$OUTPUT/DerivedData"
if [[ "$preflight_status" -ne 0 ]]; then exit "$preflight_status"; fi
exit "$status"
