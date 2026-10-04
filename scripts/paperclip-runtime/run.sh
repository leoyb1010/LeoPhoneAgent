#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE="${1:?请指定已准备的固定版本上游目录}"
OUTPUT="${PAPERCLIP_SMOKE_OUTPUT:-$ROOT/paperclip-runtime-results}"
mkdir -p "$OUTPUT"
[[ "$(git -C "$SOURCE" rev-parse HEAD)" == 994d6edcdd4e15d5f9cc5cf8c135ac599104b86a ]] || exit 2
[[ "${CI:-}" == true && "${PAPERCLIP_ALLOW_EPHEMERAL_SMOKE:-}" == 1 ]] || { echo '仅允许明确启用的隔离CI，拒绝对普通开发实例进行写入测试'; exit 2; }
: "${DATABASE_URL:?仅限CI一次性PostgreSQL服务}"
node -e 'const u=new URL(process.env.DATABASE_URL); if (!["postgres:","postgresql:"].includes(u.protocol)||!["127.0.0.1","localhost"].includes(u.hostname)||u.pathname!=="/paperclip"||u.username!=="paperclip") process.exit(2)' || { echo '拒绝连接非回环专用测试数据库'; exit 2; }
node -e 'const s=require("node:net").createServer();s.on("error",()=>process.exit(2));s.listen(43168,"127.0.0.1",()=>s.close())' || { echo '测试端口已被占用，拒绝复用未知服务'; exit 2; }
WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/paperclip-http.XXXXXX")"
PID=''
cleanup() { if [[ -n "$PID" ]]; then kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; fi; rm -rf "$WORK"; }
trap cleanup EXIT
mkdir -p "$WORK/home" "$WORK/state"
SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
TOOL_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
# 上游dev入口会加载runner的TypeScript定义，没有关闭runner的官方总开关。
# 此烟测只执行官方process适配器；不声称Rust/native模型provider已验证。
# 4GB沿用固定上游Dockerfile的Node构建约定，仅在标准CI运行，不调整用户机器设置。
(cd "$SOURCE" && exec env -i PATH="$PATH" HOME="$WORK/home" NODE_OPTIONS=--max-old-space-size=4096 \
 PAPERCLIP_BUILD_COMMIT=994d6edcdd4e15d5f9cc5cf8c135ac599104b86a NODE_ENV=test HOST=127.0.0.1 PORT=43168 SERVE_UI=false DATABASE_URL="$DATABASE_URL" \
 PAPERCLIP_HOME="$WORK/state" PAPERCLIP_DEPLOYMENT_MODE=authenticated PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
 PAPERCLIP_AUTH_BASE_URL_MODE=explicit PAPERCLIP_AUTH_PUBLIC_BASE_URL=http://127.0.0.1:43168 \
 BETTER_AUTH_SECRET="$SECRET" PAPERCLIP_AGENT_JWT_SECRET="$SECRET" PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="$TOOL_SECRET" \
 PAPERCLIP_MIGRATION_PROMPT=never PAPERCLIP_MIGRATION_AUTO_APPLY=true \
 PAPERCLIP_TELEMETRY_DISABLED=1 HEARTBEAT_SCHEDULER_ENABLED=false \
 node --import ./server/node_modules/tsx/dist/loader.mjs server/src/index.ts) > "$OUTPUT/server.log" 2>&1 &
PID=$!
ready=false
for _ in $(seq 1 120); do
 if ! kill -0 "$PID" 2>/dev/null; then echo '真实服务器提前退出'; exit 1; fi
 if curl --fail --silent http://127.0.0.1:43168/api/health > "$OUTPUT/health.json" && node -e 'const h=require(process.argv[1]);process.exit(h.status==="ok" && h.deploymentMode==="authenticated" && h.commit==="994d6edcdd4e15d5f9cc5cf8c135ac599104b86a" ? 0 : 1)' "$OUTPUT/health.json"; then ready=true; break; fi
 sleep 2
done
[[ "$ready" == true ]] || { echo '服务器240秒内未就绪'; exit 1; }
PAPERCLIP_SMOKE_URL=http://127.0.0.1:43168 PAPERCLIP_SMOKE_OUTPUT="$OUTPUT" timeout 240 node "$ROOT/scripts/paperclip-runtime/smoke.mjs"
