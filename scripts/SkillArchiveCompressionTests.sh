#!/usr/bin/env bash
# Compile the real Apple branch for iOS, then execute against macOS Compression.
# A Linux portable parse is deliberately not accepted as this native gate.
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: Apple Compression tests require macOS/Xcode; no native check performed" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNC="$ROOT/src/ios/Agent/Sync/V2"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/skill-compression.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
SWIFTC="$(xcrun --find swiftc)"
FILES=("$SYNC/SyncFileSafety.swift" "$SYNC/SafeSkillArchive.swift" "$ROOT/scripts/SkillArchiveCompressionSmoke.swift")
"$SWIFTC" -typecheck -parse-as-library -swift-version 5 \
  -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" -target arm64-apple-ios26.0-simulator \
  -module-cache-path "$WORK/modules-ios" "${FILES[@]}"
"$SWIFTC" -parse-as-library -swift-version 5 -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -module-cache-path "$WORK/modules-mac" "${FILES[@]}" -o "$WORK/compression-tests"
python3 - "$WORK" <<'PY'
import io
import pathlib
import sys
import zipfile
root = pathlib.Path(sys.argv[1])
for descriptor in (False, True):
    class Output(io.BytesIO):
        def seekable(self):
            return not descriptor
        def seek(self, *args):
            if descriptor:
                raise io.UnsupportedOperation('streaming ZIP')
            return super().seek(*args)
    stream = Output()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('SKILL.md', b'hello from Apple Compression\n')
        archive.writestr('empty.txt', b'')
    (root / ('descriptor.zip' if descriptor else 'regular.zip')).write_bytes(stream.getvalue())
PY
"$WORK/compression-tests" "$WORK/regular.zip" "$WORK/descriptor.zip"
