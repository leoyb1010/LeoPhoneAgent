import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * The codex fallback binary (~300MB) is no longer bundled into the DMG.
 * When the user has no `codex` CLI of their own, the platform package is
 * downloaded from npm on first use and cached under ~/.leocodebox/vendor.
 */

const TARGET_TRIPLES: Record<string, Record<string, { triple: string; pkgSuffix: string }>> = {
  darwin: {
    arm64: { triple: 'aarch64-apple-darwin', pkgSuffix: 'darwin-arm64' },
    x64: { triple: 'x86_64-apple-darwin', pkgSuffix: 'darwin-x64' },
  },
  linux: {
    arm64: { triple: 'aarch64-unknown-linux-musl', pkgSuffix: 'linux-arm64' },
    x64: { triple: 'x86_64-unknown-linux-musl', pkgSuffix: 'linux-x64' },
  },
};

function getPlatformTarget(): { triple: string; pkgSuffix: string } | null {
  return TARGET_TRIPLES[process.platform]?.[process.arch] ?? null;
}

export function getCodexMetaVersion(): string | null {
  try {
    const packageJson = require('@openai/codex/package.json') as { version?: string };
    return packageJson.version || null;
  } catch {
    return null;
  }
}

/** True when the platform binary package survived packaging (dev installs). */
export function isBundledCodexBinaryAvailable(): boolean {
  const target = getPlatformTarget();
  if (!target) return false;
  try {
    require.resolve(`@openai/codex-${target.pkgSuffix}/package.json`);
    return true;
  } catch {
    return false;
  }
}

function getFallbackRoot(version: string): string {
  return path.join(os.homedir(), '.leocodebox', 'vendor', 'codex', version);
}

function getFallbackBinaryPath(version: string, triple: string): string {
  // npm tarballs unpack under a top-level `package/` directory.
  return path.join(getFallbackRoot(version), 'package', 'vendor', triple, 'bin', 'codex');
}

let downloadPromise: Promise<string> | null = null;

async function downloadAndExtract(version: string, target: { triple: string; pkgSuffix: string }, onProgress?: (message: string) => void): Promise<string> {
  const root = getFallbackRoot(version);
  const binaryPath = getFallbackBinaryPath(version, target.triple);
  const tarballUrl = `https://registry.npmjs.org/@openai/codex/-/codex-${version}-${target.pkgSuffix}.tgz`;
  const tarballPath = path.join(root, 'codex.tgz');

  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  onProgress?.(`正在下载 Codex 运行组件（约 300MB，仅首次）：${tarballUrl}`);

  const response = await fetch(tarballUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Codex 组件下载失败（HTTP ${response.status}）。也可以自行安装 codex CLI 后重试。`);
  }
  await pipeline(response.body, fsSync.createWriteStream(tarballPath, { mode: 0o600 }));

  onProgress?.('下载完成，正在解压…');
  await execFileAsync('tar', ['-xzf', tarballPath, '-C', root], { timeout: 120_000 });
  await fs.rm(tarballPath, { force: true });

  await fs.access(binaryPath, fsSync.constants.X_OK);
  onProgress?.('Codex 运行组件就绪。');
  return binaryPath;
}

/**
 * Resolves an executable codex binary path when neither the user CLI nor the
 * bundled package is available. Returns null when the SDK's own resolution
 * should be used. Single-flight: concurrent runs share one download.
 */
export async function ensureFallbackCodexBinary(onProgress?: (message: string) => void): Promise<string | null> {
  if (isBundledCodexBinaryAvailable()) {
    return null;
  }

  const target = getPlatformTarget();
  const version = getCodexMetaVersion();
  if (!target || !version) {
    return null;
  }

  const binaryPath = getFallbackBinaryPath(version, target.triple);
  try {
    await fs.access(binaryPath, fsSync.constants.X_OK);
    return binaryPath;
  } catch {
    // Not cached yet: fall through to download.
  }

  if (!downloadPromise) {
    downloadPromise = downloadAndExtract(version, target, onProgress)
      .finally(() => {
        downloadPromise = null;
      });
  }
  return downloadPromise;
}

export const codexFallbackInternals = { getFallbackBinaryPath, getPlatformTarget };
