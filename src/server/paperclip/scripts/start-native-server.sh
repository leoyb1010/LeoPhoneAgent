#!/bin/bash
set -euo pipefail
umask 077
paperclip_root="${PAPERCLIP_DEPLOY_ROOT:-${HOME}/.leophoneagent/paperclip}"
source "$paperclip_root/env/server.env"
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
