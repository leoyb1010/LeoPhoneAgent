#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$ROOT/../.." && pwd)"
python3 - "$ROOT" "$REPO" <<'PY'
import re, sys
root, repo = sys.argv[1], sys.argv[2]
app = open(f"{root}/app/AppScope/app.json5", encoding="utf-8").read()
catalog = open(f"{root}/app/entry/src/main/ets/release/ReleaseCatalog.ets", encoding="utf-8").read()
changelog = open(f"{repo}/CHANGELOG.md", encoding="utf-8").read()
version_name = re.search(r'"versionName"\s*:\s*"([^"]+)"', app).group(1)
version_code = re.search(r'"versionCode"\s*:\s*(\d+)', app).group(1)
catalog_version = re.search(r"currentVersion:\s*string\s*=\s*'([^']+)'", catalog).group(1)
catalog_build = re.search(r"currentBuild:\s*number\s*=\s*(\d+)", catalog).group(1)
first_note = re.search(r"first\.version = '([^']+)'", catalog).group(1)
errors = []
if version_name != catalog_version:
    errors.append(f"versionName {version_name} != ReleaseCatalog.currentVersion {catalog_version}")
if version_code != catalog_build:
    errors.append(f"versionCode {version_code} != ReleaseCatalog.currentBuild {catalog_build}")
if version_name != first_note:
    errors.append(f"versionName {version_name} != first release note {first_note}")
if version_name not in changelog:
    errors.append(f"CHANGELOG.md missing {version_name}")
if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"HARMONY_NOTES_OK {version_name} {version_code}")
PY
