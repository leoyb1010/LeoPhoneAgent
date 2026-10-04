#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="${1:-$HERE/.upstream}"
IMAGE="${2:-leophone-paperclip-zh:994d6ed}"
node "$HERE/scripts/localize.mjs" verify "$SOURCE"
COMMIT="$(node -p "require('$HERE/upstream.lock.json').commit")"
docker build --target production --build-arg "PAPERCLIP_BUILD_COMMIT=$COMMIT" \
  --build-arg "PAPERCLIP_BUILD_VERSION=leophone-zh-994d6ed" -t "$IMAGE" "$SOURCE"
echo "已构建中文镜像：$IMAGE。尚未启动容器或部署。"
