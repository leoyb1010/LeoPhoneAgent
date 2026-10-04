#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
if [[ "$(uname -s)" != Darwin ]]; then
  echo '需要 macOS、Xcode 和 iOS 模拟器；此检查不能在 Linux 上代替执行。' >&2
  exit 2
fi
command -v xcodegen >/dev/null || { echo '请先安装 xcodegen：brew install xcodegen' >&2; exit 2; }
OUTPUT="${PAPERCLIP_AUDIT_OUTPUT:-$ROOT/native-paperclip-audit-results}"
mkdir -p "$OUTPUT"
xcodegen generate --spec scripts/native-paperclip-audit/project.yml --project scripts/native-paperclip-audit
# 每次使用新结果路径，避免覆盖上一次测试证据。
RESULT="$OUTPUT/Paperclip-$(date +%Y%m%d-%H%M%S).xcresult"
xcodebuild -version | tee "$OUTPUT/xcode-version.txt"
xcrun simctl list devices available > "$OUTPUT/simulators.txt"
set +e
xcodebuild test -project scripts/native-paperclip-audit/PaperclipNativeAudit.xcodeproj \
  -scheme PaperclipNativeAudit \
  -destination "${PAPERCLIP_TEST_DESTINATION:-platform=iOS Simulator,name=iPhone 17 Pro,OS=26.5}" \
  -parallel-testing-enabled NO \
  -test-timeouts-enabled YES -default-test-execution-time-allowance 240 -maximum-test-execution-time-allowance 300 \
  -resultBundlePath "$RESULT" \
  -derivedDataPath "$OUTPUT/DerivedData" \
  CODE_SIGNING_ALLOWED=NO 2>&1 | tee "$OUTPUT/xcodebuild.log"
STATUS=${PIPESTATUS[0]}
set -e
if [[ -d "$RESULT" ]]; then
  xcrun xcresulttool get test-results summary --path "$RESULT" --format json > "$OUTPUT/test-summary.json" || true
  xcrun xcresulttool export attachments --path "$RESULT" --output-path "$OUTPUT/attachments" || true
fi
printf '%s\n' "$RESULT" > "$OUTPUT/result-path.txt"
if [[ "$STATUS" == 0 ]]; then
  echo "原生编译、契约单测与中文界面旅程已完成：$RESULT"
else
  echo "原生验证失败，保留原始错误与结果：$RESULT" >&2
fi
exit "$STATUS"
