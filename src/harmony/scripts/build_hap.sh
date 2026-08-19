#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/app"
STAGE="${HARMONY_BUILD_DIR:-/tmp/leo-harmony-app}"
bash "$ROOT/scripts/verify_harmony_release_notes.sh"
if [[ ! -f "$APP/local.properties" ]]; then
  cp "$APP/local.properties.example" "$APP/local.properties"
fi
rm -rf "$STAGE"
mkdir -p "$STAGE"
rsync -a --delete --exclude '.hvigor' --exclude 'oh_modules' --exclude '*/build' "$APP/" "$STAGE/"
PLUGIN="${HVIGOR_OHOS_PLUGIN:-/Applications/DevEco-Studio.app/Contents/tools/hvigor/hvigor-ohos-plugin}"
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
HVIGOR="${HVIGOR:-/Applications/DevEco-Studio.app/Contents/tools/hvigor/bin/hvigorw}"
export DEVECO_SDK_HOME="${DEVECO_SDK_HOME:-/Applications/DevEco-Studio.app/Contents/sdk}"
export PATH="/Applications/DevEco-Studio.app/Contents/tools/ohpm/bin:${PATH}"
cd "$STAGE"
"$HVIGOR" --mode module -p module=entry@default -p product=default assembleHap --no-daemon
echo "HAP_STAGE=$STAGE"
find "$STAGE" -name '*.hap' -print
