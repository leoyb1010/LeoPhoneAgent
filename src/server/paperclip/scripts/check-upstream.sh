#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# 1.1.6：参数先转为绝对物理路径；后面会 cd 到上游目录，相对路径不能再依赖调用者的当前目录。
SOURCE_ARG="${1:-$HERE/.upstream}"
if [[ ! -d "$SOURCE_ARG" ]]; then echo "上游目录不存在：$SOURCE_ARG" >&2; exit 2; fi
SOURCE="$(cd "$SOURCE_ARG" && pwd -P)"
# 使用上游锁定的 pnpm 版本，不依赖 PATH 中可能失效的全局 pnpm/corepack shim。
PNPM_SPEC="$(node -p 'require(process.argv[1]).packageManager' "$HERE/upstream.lock.json")"
pnpm_locked() { npx -y "$PNPM_SPEC" "$@"; }

node "$HERE/scripts/localize.mjs" verify "$SOURCE"
node "$HERE/scripts/apply-test-storage.mjs" verify "$SOURCE"
node "$HERE/scripts/apply-native-cli-auth.mjs" verify "$SOURCE"
node "$HERE/scripts/coverage-contract.mjs" "$HERE/reports/coverage.json"
node "$HERE/scripts/check-protocol-invariants.mjs" "$SOURCE"

# 1.1.6：先安装上游依赖，再运行需要 ui/node_modules（如 @tanstack/react-query）的发行层回归。
cd "$SOURCE"
pnpm_locked --version
pnpm_locked install --frozen-lockfile
(cd "$HERE" && PAPERCLIP_SOURCE="$SOURCE" PAPERCLIP_CANDIDATE="$SOURCE" npm test && npm run test:native-launcher)

pnpm_locked --filter @paperclipai/plugin-sdk build
pnpm_locked --filter @paperclipai/ui typecheck
pnpm_locked --filter @paperclipai/ui exec vitest run src/pages/Auth.zh-CN.test.tsx src/pages/Agents.zh-CN.test.tsx src/i18n/zh-CN.ui.test.tsx
pnpm_locked --filter @paperclipai/ui build
# Smoke suite targets isolated fixtures; it never logs into a real provider.
if [[ -n "${CI:-}" ]]; then
  pnpm_locked exec playwright install --with-deps chromium
fi
node "$HERE/scripts/ui-smoke.mjs" "$SOURCE"
