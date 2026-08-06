#!/usr/bin/env bash
# 一键启动 desktop + server，重复执行会先杀旧进程再重启

set -e

kill_existing() {
  # 杀掉旧的 electron-forge / tsx dev 进程
  taskkill //F //FI "WINDOWTITLE eq *electron-forge*" 2>/dev/null || true
  taskkill //F //IM electron.exe 2>/dev/null || true

  # 杀掉占用 server 端口的进程
  local port="${PORT:-3333}"
  local pid
  pid=$(netstat -ano 2>/dev/null | grep ":${port} " | grep LISTENING | awk '{print $5}' | head -1)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then
    taskkill //F //PID "$pid" 2>/dev/null || true
  fi

  sleep 1
}

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Killing existing processes..."
kill_existing

echo "==> Starting server..."
pnpm --filter server dev &
SERVER_PID=$!

sleep 2

echo "==> Starting desktop..."
pnpm --filter desktop dev &
DESKTOP_PID=$!

echo ""
echo "==> Both running. Press Ctrl+C to stop all."
echo "    Server PID: $SERVER_PID"
echo "    Desktop PID: $DESKTOP_PID"

# Ctrl+C 时杀掉两个子进程
trap 'echo "==> Stopping..."; kill $SERVER_PID $DESKTOP_PID 2>/dev/null; exit 0' INT TERM

wait
