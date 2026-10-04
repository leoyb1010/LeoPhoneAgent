#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="${1:-$HERE/.upstream}"
node "$HERE/scripts/localize.mjs" verify "$SOURCE"
node "$HERE/scripts/coverage-contract.mjs" "$HERE/reports/coverage.json"
(cd "$HERE" && npm test)
cd "$SOURCE"
corepack pnpm --version
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @paperclipai/plugin-sdk build
corepack pnpm --filter @paperclipai/ui typecheck
corepack pnpm --filter @paperclipai/ui build
# Smoke suite targets isolated fixtures; it never logs into a real provider.
if [[ -n "${CI:-}" ]]; then
  corepack pnpm exec playwright install --with-deps chromium
fi
node "$HERE/scripts/ui-smoke.mjs" "$SOURCE"
