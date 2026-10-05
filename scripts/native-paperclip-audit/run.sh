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
# DerivedData 不放在仓库内：仓库目录的扩展属性会让签名步骤失败，也避免产物混入工作树。
DERIVED="${PAPERCLIP_AUDIT_DERIVED_DATA:-$HOME/Library/Developer/Xcode/DerivedData/LeoPhoneAgent-paperclip-audit}"
mkdir -p "$OUTPUT"
# 不写死设备名和系统版本：显式传入，或从本机模拟器白名单策略取固定 iPhone 的 UDID。
if [[ -n "${PAPERCLIP_TEST_DESTINATION:-}" ]]; then
  DESTINATION="$PAPERCLIP_TEST_DESTINATION"
else
  POLICY="$HOME/.config/apple-simulator-policy/simulators.py"
  if [[ ! -f "$POLICY" ]]; then
    echo '请用 PAPERCLIP_TEST_DESTINATION 显式指定模拟器，例如 PAPERCLIP_TEST_DESTINATION="id=<UDID>"。' >&2
    exit 2
  fi
  python3 "$POLICY" check >/dev/null || { echo '本机模拟器策略检查未通过，先处理后再运行。' >&2; exit 2; }
  DESTINATION="id=$(python3 "$POLICY" id iphone)"
fi
xcodegen generate --spec scripts/native-paperclip-audit/project.yml --project scripts/native-paperclip-audit
# 每次使用新结果路径，避免覆盖上一次测试证据。
RESULT="$OUTPUT/Paperclip-$(date +%Y%m%d-%H%M%S).xcresult"
xcodebuild -version | tee "$OUTPUT/xcode-version.txt"
xcrun simctl list devices available > "$OUTPUT/simulators.txt"
set +e
xcodebuild test -project scripts/native-paperclip-audit/PaperclipNativeAudit.xcodeproj \
  -scheme PaperclipNativeAudit \
  -destination "$DESTINATION" \
  -parallel-testing-enabled NO -maximum-concurrent-test-simulator-destinations 1 \
  -test-timeouts-enabled YES -default-test-execution-time-allowance 240 -maximum-test-execution-time-allowance 300 \
  -resultBundlePath "$RESULT" \
  -derivedDataPath "$DERIVED" \
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
