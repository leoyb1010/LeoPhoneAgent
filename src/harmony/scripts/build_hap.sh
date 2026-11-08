#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
STAGE="${HARMONY_BUILD_DIR:-/tmp/leo-harmony-app}"
TOOLCHAIN="${HARMONY_TOOLCHAIN_HOME:-$HOME/Dev/leo-harmony-toolchain/26.0.0.105/Contents}"
if [[ ! -d "$TOOLCHAIN/sdk/default" ]]; then
  TOOLCHAIN="/Applications/DevEco-Studio.app/Contents"
fi
export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-$TOOLCHAIN/sdk}"

bash "$ROOT/scripts/verify_harmony_release_notes.sh"
python3 "$ROOT/scripts/prepare_linux.py"
python3 "$ROOT/scripts/prepare_ssh.py"
if [[ ! -f "$APP/local.properties" ]]; then
  cp "$APP/local.properties.example" "$APP/local.properties"
fi
RELAY_LOCAL="$APP/entry/src/main/ets/net/RelayLocal.ets"
if [[ ! -f "$RELAY_LOCAL" ]]; then
  cp "$APP/entry/src/main/ets/net/RelayLocal.example.ets" "$RELAY_LOCAL"
  echo "提示：未找到 RelayLocal.ets，已用空模板（App 内显示「未配置中继地址」）。"
fi
mkdir -p "$STAGE"
# Keep the IDE project and locally generated signing material across builds.
# Recreating this directory closes project dialogs and discards the upgrade signer.
python3 - "$STAGE" <<'PY'
import json, pathlib, sys
stage = pathlib.Path(sys.argv[1])
profile = stage / 'build-profile.json5'
if profile.exists():
    try:
        configs = json.loads(profile.read_text()).get('app', {}).get('signingConfigs', [])
        if configs:
            local = stage / '.local-signing.json'
            local.touch(mode=0o600, exist_ok=True)
            local.chmod(0o600)
            local.write_text(json.dumps(configs))
    except json.JSONDecodeError:
        raise SystemExit('现有舞台构建配置无法解析，请检查后再构建，签名材料已保留')
PY
rsync -a --delete --exclude '.idea' --exclude '.local-signing.json' --exclude '.hvigor' --exclude 'oh_modules' --exclude '*/build' "$APP/" "$STAGE/"
python3 - "$STAGE" "${HARMONY_SIGNING_PROFILE:-$STAGE/.local-signing.json}" <<'PY'
import json, pathlib, sys
stage, local = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
if local.exists():
    configs = json.loads(local.read_text())
    if not isinstance(configs, list) or not configs:
        raise SystemExit('本地签名配置必须是非空 signingConfigs 数组')
    profile = stage / 'build-profile.json5'
    data = json.loads(profile.read_text())
    data['app']['signingConfigs'] = configs
    profile.chmod(0o600)
    profile.write_text(json.dumps(data, indent=2))
PY
PLUGIN="${HVIGOR_OHOS_PLUGIN:-$TOOLCHAIN/tools/hvigor/hvigor-ohos-plugin}"
python3 - "$STAGE/hvigor/hvigor-config.json5" "$PLUGIN" <<'PY'
import json, pathlib, sys
path, plugin = pathlib.Path(sys.argv[1]), sys.argv[2]
text = path.read_text(encoding="utf-8")
# json5 with comments-free subset: keep it as a tiny rewrite
path.write_text(
    '{\n  "modelVersion": "5.0.0",\n  "dependencies": {\n    "@ohos/hvigor-ohos-plugin": "file:%s"\n  }\n}\n' % plugin,
    encoding="utf-8",
)
PY
HVIGOR="${HVIGOR:-$TOOLCHAIN/tools/hvigor/bin/hvigorw}"
export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-/Applications/DevEco-Studio.app/Contents/sdk}"
export PATH="$TOOLCHAIN/tools/ohpm/bin:${PATH}"
cd "$STAGE"
ohpm install --all
"$HVIGOR" --mode module -p module=entry@default -p product=default assembleHap --no-daemon
echo "HAP_STAGE=$STAGE"
find "$STAGE" -name '*.hap' -print
