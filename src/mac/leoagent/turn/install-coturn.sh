#!/bin/bash
# [leo][WP-51] Mac mini 上部署 coturn(看屏 R1 的 STUN + TURN 中转)。说明见同目录 README.md。
#
# 只在 Mac mini 上由人手动执行;LeoBot 本身不会运行它。
#
#   ./install-coturn.sh install --external-ip <公网IP>[/<内网IP>] [--realm leobot] [--host <对外域名或IP>]
#   ./install-coturn.sh status
#   ./install-coturn.sh verify [--host <对外域名或IP>]   # STUN 探测 + 用短期凭据跑一次中转自检
#   ./install-coturn.sh uninstall         # 停服务(保留配置与密钥)
#
# 安全约定:
# - 只用 TURN REST 短期凭据(use-auth-secret):共享密钥只在 Mac mini 与各台 Mac 的 ~/.leoagent/link/turn.json 里,
#   手机只拿到 Mac 签发的、默认 1 小时过期的用户名 / 密码。
# - 禁止中转到内网、回环、Tailscale 网段(denied-peer-ip),防止被当成进内网的跳板。
# - 密钥文件权限 0600,脚本不把密钥打到终端。
set -euo pipefail

ACTION="${1:-}"
shift || true

EXTERNAL_IP=""
REALM="leobot"
PUBLIC_HOST=""
PORT=3478
MIN_PORT=49160
MAX_PORT=49200
while [ $# -gt 0 ]; do
  case "$1" in
    --external-ip) EXTERNAL_IP="$2"; shift 2 ;;
    --realm) REALM="$2"; shift 2 ;;
    --host) PUBLIC_HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "未知参数:$1" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "只支持 macOS(Mac mini)" >&2
  exit 1
fi
if ! command -v brew >/dev/null 2>&1; then
  echo "需要 Homebrew:https://brew.sh" >&2
  exit 1
fi

PREFIX="$(brew --prefix)"
CONF="$PREFIX/etc/turnserver.conf"
SECRET_FILE="$HOME/.leoagent/turn/secret"
CLIENT_FILE="$HOME/.leoagent/turn/turn.json"
LOG_FILE="$PREFIX/var/log/coturn.log"

ensure_secret() {
  mkdir -p "$(dirname "$SECRET_FILE")"
  chmod 700 "$(dirname "$SECRET_FILE")"
  if [ ! -s "$SECRET_FILE" ]; then
    umask 077
    openssl rand -hex 32 > "$SECRET_FILE"
  fi
  chmod 600 "$SECRET_FILE"
}

write_conf() {
  local secret
  secret="$(cat "$SECRET_FILE")"
  if [ -f "$CONF" ] && ! grep -q "LeoBot coturn" "$CONF"; then
    cp "$CONF" "$CONF.bak.$(date +%Y%m%d%H%M%S)"
  fi
  umask 077
  cat > "$CONF" <<CONF
# LeoBot coturn — 由 src/mac/leoagent/turn/install-coturn.sh 生成,改参数请重新运行脚本。
listening-port=$PORT
min-port=$MIN_PORT
max-port=$MAX_PORT
${EXTERNAL_IP:+external-ip=$EXTERNAL_IP}
realm=$REALM
fingerprint
use-auth-secret
static-auth-secret=$secret
stale-nonce=600
user-quota=4
total-quota=16
no-cli
no-multicast-peers
no-tlsv1
no-tlsv1_1
# 不中转到内网 / 回环 / 链路本地 / Tailscale(这些路径本来就该直连)。
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
log-file=$LOG_FILE
simple-log
CONF
  chmod 600 "$CONF"
}

write_client_config() {
  local host="${PUBLIC_HOST:-${EXTERNAL_IP%%/*}}"
  if [ -z "$host" ]; then
    echo "需要 --host 或 --external-ip 来生成各台 Mac 用的 turn.json" >&2
    return
  fi
  local secret
  secret="$(cat "$SECRET_FILE")"
  umask 077
  cat > "$CLIENT_FILE" <<JSON
{
  "urls": [
    "stun:$host:$PORT",
    "turn:$host:$PORT?transport=udp",
    "turn:$host:$PORT?transport=tcp"
  ],
  "secret": "$secret",
  "ttl_seconds": 3600
}
JSON
  chmod 600 "$CLIENT_FILE"
  echo "各台 Mac 用的配置已写到 $CLIENT_FILE(含共享密钥,权限 0600)。"
  echo "复制到每台 Mac 的 ~/.leoagent/link/turn.json(同样 chmod 600),重启 LeoBot 生效。"
}

case "$ACTION" in
  install)
    brew list coturn >/dev/null 2>&1 || brew install coturn
    ensure_secret
    write_conf
    write_client_config
    brew services restart coturn
    echo "coturn 已启动:UDP/TCP $PORT,中转端口 $MIN_PORT-$MAX_PORT。"
    echo "路由器需要把这些端口转发到 Mac mini(UDP $PORT、TCP $PORT、UDP $MIN_PORT-$MAX_PORT)。"
    ;;
  status)
    brew services info coturn || true
    [ -f "$LOG_FILE" ] && tail -n 20 "$LOG_FILE" || true
    ;;
  verify)
    ensure_secret
    command -v turnutils_uclient >/dev/null 2>&1 || { echo "没有 turnutils_uclient(随 coturn 安装)" >&2; exit 1; }
    expiry=$(( $(date +%s) + 600 ))
    user="$expiry:leobot-verify"
    pass="$(printf '%s' "$user" | openssl dgst -sha1 -hmac "$(cat "$SECRET_FILE")" -binary | base64)"
    # -y:两个客户端经中转互发(不需要另起 peer);目标用公网地址,走一遍真实的中转路径。
    target="${PUBLIC_HOST:-${EXTERNAL_IP%%/*}}"
    turnutils_stunclient -p "$PORT" "${target:-127.0.0.1}"
    turnutils_uclient -y -n 10 -m 1 -p "$PORT" -u "$user" -w "$pass" "${target:-127.0.0.1}"
    ;;
  uninstall)
    brew services stop coturn || true
    echo "已停止 coturn;配置 $CONF 与密钥 $SECRET_FILE 保留。"
    ;;
  *)
    sed -n '2,16p' "$0"
    exit 2
    ;;
esac
