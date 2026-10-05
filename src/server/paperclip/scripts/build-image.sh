#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="${1:-$HERE/.upstream}"
IMAGE="${2:-leophone-paperclip-zh:994d6ed}"
# 1.1.6：与 prepare.sh 一致，三层叠加（汉化、测试存储、原生 CLI/后端）全部核对后才构建。
node "$HERE/scripts/localize.mjs" verify "$SOURCE"
node "$HERE/scripts/apply-test-storage.mjs" verify "$SOURCE"
node "$HERE/scripts/apply-native-cli-auth.mjs" verify "$(cd "$SOURCE" && pwd -P)"
COMMIT="$(node -p 'require(process.argv[1]).commit' "$HERE/upstream.lock.json")"
docker build --target production --build-arg "PAPERCLIP_BUILD_COMMIT=$COMMIT" \
  --build-arg "PAPERCLIP_BUILD_VERSION=leophone-zh-994d6ed" -t "$IMAGE" "$SOURCE"
echo "已构建中文镜像：$IMAGE。尚未启动容器或部署。（Docker 路线未经验收，当前主线为 launchd 原生部署）"
