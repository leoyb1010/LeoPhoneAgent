#!/usr/bin/env bash
#
# Prepare Android sandbox assets:
#   1. Download Alpine Linux aarch64 minirootfs
#   2. Download PRoot aarch64 static binary from Termux packages
#   3. Place both into src/android/app/src/main/assets/
#
# Usage: ./scripts/prepare_android_sandbox.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ASSETS_DIR="$PROJECT_ROOT/src/android/app/src/main/assets"

ALPINE_VERSION="3.21"
ALPINE_RELEASE="3.21.3"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/releases/aarch64/alpine-minirootfs-${ALPINE_RELEASE}-aarch64.tar.gz"
ALPINE_SHA256="ead8a4b37867bd19e7417dd078748e2312c0aea364403d96758d63ea8ff261ea"

# Termux proot package — aarch64 static binary
PROOT_VERSION="5.1.107-70"
PROOT_DEB_URL="https://packages.termux.dev/apt/termux-main/pool/main/p/proot/proot_${PROOT_VERSION}_aarch64.deb"
PROOT_SHA256="186b9f886bf0ee806f75b57f5de68cdc9641a483970bab0ada7cd6b6f737a778"

verify_sha256() {
    local file="$1"
    local expected="$2"
    local actual
    if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$file" | awk '{print $1}')"
    else
        actual="$(shasum -a 256 "$file" | awk '{print $1}')"
    fi
    if [ "$actual" != "$expected" ]; then
        echo "Error: SHA-256 mismatch for $file" >&2
        echo "Expected: $expected" >&2
        echo "Actual:   $actual" >&2
        exit 1
    fi
}

mkdir -p "$ASSETS_DIR"

ROOTFS_FILE="$ASSETS_DIR/alpine-minirootfs.tar.gz"
PROOT_FILE="$ASSETS_DIR/proot-aarch64"

# --- Alpine rootfs ---
if [ -f "$ROOTFS_FILE" ]; then
    verify_sha256 "$ROOTFS_FILE" "$ALPINE_SHA256"
    echo "✓ Alpine rootfs already exists: $ROOTFS_FILE"
else
    echo "Downloading Alpine Linux ${ALPINE_RELEASE} aarch64 minirootfs..."
    curl -fSL -o "$ROOTFS_FILE" "$ALPINE_URL"
    verify_sha256 "$ROOTFS_FILE" "$ALPINE_SHA256"
    echo "✓ Downloaded: $ROOTFS_FILE ($(du -h "$ROOTFS_FILE" | cut -f1))"
fi

# --- PRoot binary ---
if [ -f "$PROOT_FILE" ]; then
    verify_sha256 "$PROOT_FILE" "$PROOT_SHA256"
    echo "✓ PRoot binary already exists: $PROOT_FILE"
else
    echo "Downloading PRoot ${PROOT_VERSION} aarch64 from Termux..."

    TMPDIR="$(mktemp -d)"
    trap 'rm -rf "$TMPDIR"' EXIT

    DEB_FILE="$TMPDIR/proot.deb"
    curl -fSL -o "$DEB_FILE" "$PROOT_DEB_URL"

    # Extract .deb (it's an ar archive containing data.tar.xz)
    cd "$TMPDIR"
    ar x "$DEB_FILE"

    # Extract data archive
    if [ -f "data.tar.xz" ]; then
        tar xf data.tar.xz
    elif [ -f "data.tar.gz" ]; then
        tar xzf data.tar.gz
    elif [ -f "data.tar.zst" ]; then
        zstd -d data.tar.zst -o data.tar
        tar xf data.tar
    else
        echo "Error: Could not find data archive in .deb"
        ls -la "$TMPDIR"
        exit 1
    fi

    # Find the proot binary
    PROOT_BIN=$(find "$TMPDIR" -name "proot" -type f | head -1)
    if [ -z "$PROOT_BIN" ]; then
        echo "Error: Could not find proot binary in extracted .deb"
        find "$TMPDIR" -type f
        exit 1
    fi

    cp "$PROOT_BIN" "$PROOT_FILE"
    chmod +x "$PROOT_FILE"
    verify_sha256 "$PROOT_FILE" "$PROOT_SHA256"
    cd "$PROJECT_ROOT"

    echo "✓ Extracted PRoot binary: $PROOT_FILE ($(du -h "$PROOT_FILE" | cut -f1))"
fi

echo ""
echo "Assets ready in: $ASSETS_DIR"
ls -lh "$ASSETS_DIR"
