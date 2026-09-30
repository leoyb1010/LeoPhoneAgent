#!/usr/bin/env bash
# Compile the real Apple branch for iOS, then execute against macOS system zlib.
# --portable-linux additionally exercises the same decoder with system zlib.
# That explicit mode does not replace the default native Apple SDK gate.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNC="$ROOT/src/ios/Agent/Sync/V2"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/skill-compression.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
FILES=("$SYNC/SyncFileSafety.swift" "$SYNC/SafeSkillArchive.swift" "$ROOT/scripts/SkillArchiveCompressionSmoke.swift")
if [[ "$(uname -s)" == "Darwin" ]]; then
  SWIFTC="$(xcrun --find swiftc)"
  "$SWIFTC" -typecheck -parse-as-library -swift-version 5 \
    -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" -target arm64-apple-ios26.0-simulator \
    -module-cache-path "$WORK/modules-ios" "${FILES[@]}"
  "$SWIFTC" -parse-as-library -swift-version 5 -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
    -module-cache-path "$WORK/modules-mac" "${FILES[@]}" -o "$WORK/compression-tests"
elif [[ "$(uname -s)" == "Linux" && "${1:-}" == "--portable-linux" ]]; then
  # Linux has the system header/library but no Swift module map. Use a local
  # adapter with the same module name and link directive as Apple's SDK.
  test -f /usr/include/zlib.h
  mkdir "$WORK/zlib"
  printf '%s\n' 'module zlib [system] { header "/usr/include/zlib.h" export * link "z" }' > "$WORK/zlib/module.modulemap"
  "${SWIFTC:-swiftc}" -parse-as-library -swift-version 5 -I "$WORK/zlib" \
    -module-cache-path "$WORK/modules-linux" "${FILES[@]}" -o "$WORK/compression-tests"
  echo "Portable Linux system-zlib runtime check; Apple SDK gate remains separate."
else
  echo "error: Apple SDK archive tests require macOS/Xcode; no native check performed" >&2
  exit 1
fi
python3 - "$WORK" <<'PY'
import io
import pathlib
import struct
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
# The ZIP headers consistently include the extra byte in the compressed size,
# so these fixtures must be rejected by the DEFLATE framing check itself.
name = b'SKILL.md'
content = b'hello from Apple Compression\n'
import zlib
compressor = zlib.compressobj(wbits=-15)
raw = compressor.compress(content) + compressor.flush()
for index, suffix in enumerate((b'\0', b'\xff', raw, b'\x03\x00')):
    compressed = raw + suffix
    crc = zlib.crc32(content)
    local = struct.pack('<IHHHHHIIIHH', 0x04034b50, 20, 0, 8, 0, 0,
                        crc, len(compressed), len(content), len(name), 0) + name + compressed
    central = struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 20, 20, 0, 8, 0, 0,
                          crc, len(compressed), len(content), len(name), 0, 0, 0, 0, 0, 0) + name
    end = struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, 1, 1, len(central), len(local), 0)
    (root / f'trailing-{index}.invalid.zip').write_bytes(local + central + end)
PY
"$WORK/compression-tests" "$WORK"/*.zip
