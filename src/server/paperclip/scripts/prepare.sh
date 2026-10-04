#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HERE/.upstream}"
COMMIT="$(node -p "require('$HERE/upstream.lock.json').commit")"
REPO="$(node -p "require('$HERE/upstream.lock.json').repository")"
if [[ -e "$DEST" && ! -d "$DEST/.git" ]]; then
  echo "目标目录已存在但不是 Git 工作区，拒绝覆盖：$DEST" >&2; exit 1
fi
if [[ ! -d "$DEST/.git" ]]; then
  git clone --filter=blob:none --no-checkout "$REPO" "$DEST"
  git -C "$DEST" fetch --depth=1 origin "$COMMIT"
  git -C "$DEST" checkout --detach "$COMMIT"
fi
if [[ "$(git -C "$DEST" rev-parse HEAD)" != "$COMMIT" ]]; then
  echo "目标不是锁定的上游提交，请使用新目录。不会自动重置现有工作区。" >&2; exit 1
fi
(cd "$HERE" && npm ci --ignore-scripts --no-audit --no-fund)
node "$HERE/scripts/localize.mjs" apply "$DEST"
node "$HERE/scripts/localize.mjs" verify "$DEST"
printf '\n中文源码已准备：%s\n请阅读 docs/DEPLOYMENT.zh-CN.md 后构建和部署。此脚本没有启动服务或修改服务器配置。\n' "$DEST"
