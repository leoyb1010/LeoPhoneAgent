#!/bin/sh
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

# Validate the real registration sites as well as the compiled proxy behavior.
# This is not a replacement for device/TCC or direct Swift route tests.
python3 - <<'PY'
from pathlib import Path
import re
root = Path('src/ios')
registrations = []
for source in root.rglob('*.m'):
    text = source.read_text()
    for match in re.finditer(r'native_offload_add_handler\("([^\"]+)"\s*,', text):
        prefix = text[:match.start()]
        if not re.search(r'#(?:import|include)\s+"NativeOffloadUtils.h"', prefix):
            raise SystemExit(f'Unguarded registration: {source}:{text[:match.start()].count(chr(10))+1}')
        registrations.append(match.group(1))
header = (root / 'NativeOffloads/NativeOffloadUtils.h').read_text()
if not re.search(r'#define native_offload_add_handler\(guest_name, handler\)\s*\\\s*noff_register_authorized_handler', header):
    raise SystemExit('Device registration no longer uses the authorization proxy')
known = set(re.findall(r'\.init\(name: "(apple-[^\"]+)"', (root / 'Agent/Offload/OffloadPermissionManager.swift').read_text()))
apple = {name for name in registrations if name.startswith('apple-')}
if apple - known:
    raise SystemExit(f'Missing permission descriptors: {sorted(apple-known)}')
capacity = int(re.search(r'#define NATIVE_OFFLOAD_MAX\s+(\d+)', Path('deps/ish/kernel/native_offload.h').read_text()).group(1))
proxy_capacity = int(re.search(r'#define NOFF_DISPATCH_CAPACITY\s+(\d+)', (root / 'NativeOffloads/NativeOffloadDispatch.h').read_text()).group(1))
if len(registrations) > capacity or len(apple) > proxy_capacity:
    raise SystemExit('A native registry would overflow; do not register an unguarded fallback')
print(f'Native registration wiring: {len(registrations)}/{capacity} kernel slots, {len(apple)}/{proxy_capacity} guarded Apple slots')
PY

stage=$(mktemp -d "${TMPDIR:-/tmp}/ios-native-permission.XXXXXX")
trap 'rm -rf "$stage"' EXIT HUP INT TERM
clang -std=c11 -Wall -Wextra -Werror \
  scripts/IOSNativePermissionDispatchSmoke.c \
  src/ios/NativeOffloads/NativeOffloadDispatch.c -o "$stage/dispatch-smoke"
"$stage/dispatch-smoke"
