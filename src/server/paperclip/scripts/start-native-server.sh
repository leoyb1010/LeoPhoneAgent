#!/bin/bash
set -euo pipefail
umask 077
paperclip_root="${PAPERCLIP_DEPLOY_ROOT:-${HOME}/.leophoneagent/paperclip}"
paperclip_env="$paperclip_root/env/server.env"
# 1.1.6：server.env 含数据库口令与签名密钥，source 前确认是当前用户拥有、权限不宽于 0600 的普通文件；
# 否则拒绝启动（不自动 chmod，避免掩盖被替换或被他人写入的情况）。
if [[ ! -f "$paperclip_env" || -L "$paperclip_env" ]]; then
  echo "Paperclip env guard: $paperclip_env must be a regular file" >&2; exit 78
fi
if [[ "$(/usr/bin/stat -f %u "$paperclip_env")" != "$(/usr/bin/id -u)" ]]; then
  echo "Paperclip env guard: $paperclip_env must be owned by the service user" >&2; exit 78
fi
if (( (8#$(/usr/bin/stat -f %Lp "$paperclip_env") & 8#077) != 0 )); then
  echo "Paperclip env guard: $paperclip_env permissions must not be wider than 0600" >&2; exit 78
fi
source "$paperclip_env"
# 1.1.6：日志在启动时按大小轮转（超过 32 MiB 时 .log -> .1.gz，保留 3 份），无需系统级 newsyslog。
# launchd 在本脚本之前已把输出重定向到这些文件；轮转后在非终端运行时重新指向新文件，交互运行不受影响。
paperclip_log_dir="$paperclip_root/log"
rotate_paperclip_log() {
  local f="$paperclip_log_dir/$1"
  [[ -f "$f" ]] || return 0
  (( $(/usr/bin/stat -f %z "$f") > 33554432 )) || return 0
  rm -f "$f.3.gz"
  [[ -f "$f.2.gz" ]] && mv "$f.2.gz" "$f.3.gz"
  [[ -f "$f.1.gz" ]] && mv "$f.1.gz" "$f.2.gz"
  mv "$f" "$f.1" && /usr/bin/gzip -f "$f.1"
}
if [[ -d "$paperclip_log_dir" && ! -t 1 ]]; then
  rotate_paperclip_log server.stdout.log
  rotate_paperclip_log server.stderr.log
  exec >>"$paperclip_log_dir/server.stdout.log" 2>>"$paperclip_log_dir/server.stderr.log"
fi
if [[ -n "${PAPERCLIP_STORAGE_VOLUME:-}" || -n "${PAPERCLIP_STORAGE_VOLUME_UUID:-}" ]]; then
  /usr/bin/python3 - "$paperclip_root" "${PAPERCLIP_STORAGE_VOLUME:-}" "${PAPERCLIP_STORAGE_VOLUME_UUID:-}" <<'PY_STORAGE_GUARD'
import os
import plistlib
import subprocess
import sys

deploy_root, volume, expected_uuid = sys.argv[1:]
def fail(reason):
    sys.exit("Paperclip storage guard: " + reason)

if not volume or not os.path.isabs(volume):
    fail("PAPERCLIP_STORAGE_VOLUME must name an absolute mounted volume")
volume = os.path.realpath(volume)
if not os.path.isdir(volume) or not os.path.ismount(volume):
    fail("external storage volume is not mounted: " + volume)
try:
    info = plistlib.loads(subprocess.check_output(
        ["/usr/sbin/diskutil", "info", "-plist", volume], stderr=subprocess.PIPE))
except (OSError, subprocess.CalledProcessError, ValueError, plistlib.InvalidFileException):
    fail("cannot verify external storage volume properties")
if info.get("Mounted") is False or os.path.realpath(info.get("MountPoint", "")) != volume:
    fail("diskutil does not confirm the configured mounted volume")
if info.get("GlobalPermissionsEnabled") is not True:
    fail("external storage volume ownership must be enabled (GlobalPermissionsEnabled=true)")
if expected_uuid and str(info.get("VolumeUUID", "")).casefold() != expected_uuid.casefold():
    fail("external storage volume UUID does not match PAPERCLIP_STORAGE_VOLUME_UUID")
deploy_root = os.path.realpath(deploy_root)
if not os.path.isdir(deploy_root) or os.path.commonpath([volume, deploy_root]) != volume:
    fail("deployment root resolves outside the configured storage volume: " + deploy_root)
PY_STORAGE_GUARD
fi
paperclip_cli_bin="${PAPERCLIP_CLI_BIN_DIR:-${HOME}/.local/npm-global/bin}"
export PATH="$paperclip_root/runtime/node-v24.11.0-darwin-arm64/bin:$paperclip_root/runtime/pnpm/node_modules/.bin:$paperclip_cli_bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$paperclip_root/release/current"
exec "$paperclip_root/runtime/node-v24.11.0-darwin-arm64/bin/node" --import ./server/node_modules/tsx/dist/loader.mjs server/dist/index.js
