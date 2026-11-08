#!/usr/bin/env python3
"""Bundle fixed, signed Alpine APKs for offline, non-downgrading App bootstrap."""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import hashlib
import gzip
import io
import tarfile
import json
import os
import re
import shutil
import struct
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
CPP = ROOT / "src/harmony/app/entry/src/main/cpp"
GENERATED = CPP / "generated"
CACHE = GENERATED / "packages"
CACHE.mkdir(parents=True, exist_ok=True)
manifest = json.loads((CPP / "linux-packages.json").read_text())


def download(entry):
    name = entry["file"]
    url = entry["url"]
    if not re.fullmatch(r"[A-Za-z0-9_.+-]+\.apk", name):
        raise SystemExit("Invalid pinned APK filename")
    if not url.startswith("https://dl-cdn.alpinelinux.org/alpine/v3.22/") or url.rsplit("/", 1)[1] != name:
        raise SystemExit("Invalid pinned APK source")
    destination = CACHE / name
    if not destination.exists():
        temporary = destination.with_suffix(".download")
        with urllib.request.urlopen(url, timeout=90) as source, temporary.open("wb") as target:
            shutil.copyfileobj(source, target)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != entry["sha256"]:
            raise SystemExit("APK download checksum mismatch: " + name)
        os.replace(temporary, destination)
    if hashlib.sha256(destination.read_bytes()).hexdigest() != entry["sha256"]:
        raise SystemExit("Cached APK checksum mismatch: " + name)


with ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(download, manifest))

lines = [
    "#!/bin/sh",
    "set -eu",
    "installed_version() {",
    "  awk -v target=\"$1\" 'BEGIN { RS=\"\"; FS=\"\\n\" }",
    "    { name=\"\"; version=\"\"; for (i=1;i<=NF;i++) {",
    "      if (substr($i,1,2)==\"P:\") name=substr($i,3);",
    "      if (substr($i,1,2)==\"V:\") version=substr($i,3);",
    "    } if (name==target) { print version; exit } }' /lib/apk/db/installed",
    "}",
    "set --",
]
versions = []
for entry in manifest:
    match = re.fullmatch(r"(.+)-(\d[^/]*-r\d+)\.apk", entry["file"])
    if not match:
        raise SystemExit("Cannot parse pinned APK version: " + entry["file"])
    name, version = match.groups()
    versions.append((name, version))
    lines.extend([
        'current="$(installed_version ' + name + ')"',
        'if [ -z "$current" ] || [ "$(apk version -t "$current" ' + version + ')" = "<" ]; then',
        '  set -- "$@" /mnt/bootstrap/' + entry["file"],
        "fi",
    ])
lines.extend([
    'if [ "$#" -gt 0 ]; then',
    '  apk --wait 60 --no-progress add --no-network "$@"',
    "fi",
])
for name, version in versions:
    lines.extend([
        'current="$(installed_version ' + name + ')"',
        'if [ -z "$current" ] || [ "$(apk version -t "$current" ' + version + ')" = "<" ]; then',
        '  echo "Required package verification failed: ' + name + '" >&2',
        "  exit 70",
        "fi",
    ])
lines.extend([
    "if [ ! -e /etc/pip.conf ]; then printf '[global]\\nbreak-system-packages = true\\n' > /etc/pip.conf; fi",
    "python3 -m pip --version",
    "npm --version",
    "python3 -c 'print(\"LEO_PYTHON_BOOTSTRAP_OK\")'",
    "node -e 'console.log(\"LEO_NODE_BOOTSTRAP_OK\")'",
    "bash --version >/dev/null",
    "git --version >/dev/null",
    "curl --version >/dev/null",
    'echo "LEO_LINUX_BOOTSTRAP_COMPLETE"',
])
script = ("\n".join(lines) + "\n").encode()
resource = ROOT / "src/harmony/app/entry/src/main/resources/rawfile/linux-packages.pack"
resource.parent.mkdir(parents=True, exist_ok=True)
with resource.with_suffix(".tmp").open("wb") as target:
    target.write(b"LEOISH01")
    for entry in sorted(manifest, key=lambda entry: entry["file"]):
        name = entry["file"].encode()
        path = CACHE / entry["file"]
        target.write(struct.pack("<IBQ", len(name), 0, path.stat().st_size))
        target.write(name)
        with path.open("rb") as source:
            shutil.copyfileobj(source, target)
    name = b"install.sh"
    target.write(struct.pack("<IBQ", len(name), 0, len(script)))
    target.write(name)
    target.write(script)
    target.write(struct.pack("<IBQ", 0, 0, 0))
os.replace(resource.with_suffix(".tmp"), resource)
digest = hashlib.sha256(resource.read_bytes()).hexdigest()
(GENERATED / "linux_packages_manifest.h").write_text(
    '#pragma once\n#define LINUX_PACKAGES_SHA256 "' + digest + '"\n'
)
(GENERATED / "package-provenance.json").write_text(json.dumps({
    "packages": manifest,
    "pack_sha256": digest,
    "signature_verification": "App guest apk validates against the bundled Alpine trusted keys",
    "upgrade_policy": "Skip equal or newer installed versions, never request a downgrade",
}, indent=2))
print("LINUX_PACKAGES_PREPARED", len(manifest), resource.stat().st_size, digest)

# Preserve the actual signed package metadata alongside the source hashes and shared GPL terms.
package_licenses = ["Bundled Alpine runtime packages. Installed by the guest apk signature verifier.\n"]
for entry in manifest:
    raw = gzip.decompress((CACHE / entry["file"]).read_bytes())
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:", ignore_zeros=True) as archive:
        metadata = archive.extractfile(".PKGINFO").read().decode()
    details = [line for line in metadata.splitlines() if line.startswith(("pkgname =", "pkgver =", "license =", "origin =", "url =", "commit ="))]
    package_licenses.append(entry["url"] + "\nSHA256 " + entry["sha256"] + "\n" + "\n".join(details))
gpl2 = (ROOT / "deps/proot/COPYING").read_text()
headers = list(re.finditer(r"GNU GENERAL PUBLIC LICENSE\s+Version 2, June 1991", gpl2))
if headers:
    package_licenses.append("GNU GPL version 2 text, shared by the GPLv2 Alpine packages.\n" + gpl2[headers[-1].start():])
(resource.parent / "linux-package-licenses.txt").write_text("\n\n".join(package_licenses))
