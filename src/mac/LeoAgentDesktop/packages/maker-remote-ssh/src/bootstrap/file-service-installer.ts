/**
 * file-service remote install — 与 cc-manager-installer 同构的独立安装路径。
 *
 * file-service.mjs 是 @cindy/remote-file-service 的 esbuild bundle(~50KB),
 * 为 SSH remote 会话提供文件浏览 RPC(listDir / readFile / write / search)。
 * 与 agent 类型无关:codex remote 会话、未来 claude remote 会话共用。
 *
 * Install layout(沿用 bundled-node 约定):
 *   ~/.xdt-server/v1/file-service/file-service.mjs   (the bundle)
 *
 * Node runtime:复用 `~/.xdt-server/v1/node/`(由 agent bootstrap 安装)。
 * probe 发现 node 缺失时直接报不可用——file-service 只在"能跑 remote 会话"
 * 的机器上才有意义,而那样的机器必然装过 agent + bundled node。
 *
 * 版本策略:probe 拿 `--version` 的 {bundleVersion, schemaVersion},由
 * caller(desktop 的 remote backend)对比 client 侧常量决定是否重推;
 * 上传幂等覆盖,无 sentinel 文件(--version 成功即已安装)。
 */

import * as fs from 'node:fs/promises';
import type { RemoteHost } from '../RemoteHost.js';
import { buildUploadScript } from './cc-manager-installer.js';

export interface FileServiceProbeResult {
  /** bundled node 存在且可跑。 */
  nodeReady: boolean;
  /** file-service.mjs 存在且 --version 输出合法 JSON。 */
  installed: boolean;
  /** daemon 报告的协议 schema 版本(未安装时 null)。 */
  schemaVersion: number | null;
  /** daemon 报告的 bundle 版本(未安装时 null)。 */
  bundleVersion: string | null;
  /** 远端 bundle 绝对路径(bash 展开后;未展开形态含 $HOME 时为原样)。 */
  binaryPath: string;
  /** bundled node 绝对路径。 */
  nodeBinaryPath: string;
  /** 远端 ripgrep 绝对路径;null = 没探测到(搜索/文件名索引降级)。 */
  rgPath: string | null;
}

/**
 * Probe remote state:node ready? file-service.mjs installed? 版本多少?
 * 只读不写(除了确保安装目录存在,与 cc-manager probe 同款幂等 mkdir)。
 */
export async function probeFileService(host: RemoteHost): Promise<FileServiceProbeResult> {
  const script = String.raw`#!/usr/bin/env bash
set -u
SERVER_VER="${'$'}{1:-v1}"
INSTALL_DIR="$HOME/.xdt-server/$SERVER_VER"
NODE_BIN="$INSTALL_DIR/node/bin/node"
FS_DIR="$INSTALL_DIR/file-service"
FS_BIN="$FS_DIR/file-service.mjs"

mkdir -p "$INSTALL_DIR" "$FS_DIR" && chmod 700 "$INSTALL_DIR" "$FS_DIR"
printf 'NODE_BIN %s\n' "$NODE_BIN"
printf 'FS_BIN %s\n' "$FS_BIN"

if [ -x "$NODE_BIN" ]; then
  V="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null || true)"
  if [ -n "$V" ]; then printf 'NODE_READY %s\n' "$V"; fi
else
  printf 'NODE_MISSING\n'
fi

if [ -f "$FS_BIN" ]; then
  V="$("$NODE_BIN" "$FS_BIN" --version 2>/dev/null || true)"
  if [ -n "$V" ]; then printf 'FS_READY %s\n' "$V"; fi
else
  printf 'FS_MISSING\n'
fi

# ripgrep 探测:PATH 里的 rg 优先;fallback 到 claude-code standalone 自带的
# vendor rg(如果这台机器装过 claude agent)。找不到就不输出 RG_PATH,搜索/
# 文件名索引在该 host 上降级(daemon 不带 --rg 启动)。
RG_BIN="$(command -v rg 2>/dev/null || true)"
if [ -z "$RG_BIN" ]; then
  RG_BIN="$(ls "$INSTALL_DIR"/claude-code/*/node_modules/@anthropic-ai/claude-code/vendor/ripgrep/*/rg 2>/dev/null | head -1 || true)"
fi
if [ -n "$RG_BIN" ] && [ -x "$RG_BIN" ]; then printf 'RG_PATH %s\n' "$RG_BIN"; fi
exit 0
`;
  const result = await host.exec(`bash -l -s -- v1`, {
    input: script,
    timeoutMs: 15_000,
    label: 'file-service-probe',
  });
  return parseFileServiceProbeOutput(result.stdout);
}

/**
 * 上传(或覆盖)file-service bundle。上传通道与 cc-manager 相同:SSH exec
 * `cat > path` stdin pipe,无 SFTP 依赖。上传后复验 --version。
 */
export async function installFileServiceBundle(
  host: RemoteHost,
  opts: { bundlePath: string },
): Promise<{ ready: boolean; error?: string; probe: FileServiceProbeResult }> {
  const probe1 = await probeFileService(host);
  if (!probe1.nodeReady) {
    return {
      ready: false,
      error:
        'bundled node not installed on remote — run installRemoteAgent first to bootstrap node',
      probe: probe1,
    };
  }

  const bytes = await fs.readFile(opts.bundlePath);
  const script = buildUploadScript(probe1.binaryPath);
  const result = await host.exec(`bash -c ${shellQuoteSh(script)}`, {
    input: bytes,
    timeoutMs: 60_000,
    label: 'file-service-upload',
  });
  if (result.exitCode !== 0) {
    return {
      ready: false,
      error: `upload failed: remote bash exit=${result.exitCode}: ${result.stderr.trim().slice(0, 200) || '(no stderr)'}`,
      probe: probe1,
    };
  }

  const probe2 = await probeFileService(host);
  if (!probe2.installed) {
    return {
      ready: false,
      error: `file-service uploaded (${bytes.length} bytes) but --version probe failed (node: ${probe2.nodeBinaryPath})`,
      probe: probe2,
    };
  }
  return { ready: true, probe: probe2 };
}

/** 卸载(rm file-service/ 目录)。幂等。 */
export async function uninstallFileService(host: RemoteHost): Promise<void> {
  await host.exec(`bash -c 'rm -rf "$HOME/.xdt-server/v1/file-service"'`, {
    timeoutMs: 10_000,
    label: 'file-service-uninstall',
  });
}

/** POSIX 单引号 shell quote(与 cc-manager-installer 内部同实现)。 */
function shellQuoteSh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 解析 probe stdout(导出供单测)。 */
export function parseFileServiceProbeOutput(stdout: string): FileServiceProbeResult {
  const lines = stdout.split(/\r?\n/);
  const get = (prefix: string): string | null => {
    for (const line of lines) {
      if (line.startsWith(prefix + ' ')) return line.slice(prefix.length + 1).trim();
      if (line === prefix) return '';
    }
    return null;
  };

  const binaryPath = get('FS_BIN') ?? '$HOME/.xdt-server/v1/file-service/file-service.mjs';
  const nodeBinaryPath = get('NODE_BIN') ?? '$HOME/.xdt-server/v1/node/bin/node';
  const nodeReady = get('NODE_READY') !== null;
  const rgRaw = get('RG_PATH');
  const rgPath = rgRaw && rgRaw.length > 0 ? rgRaw : null;

  const readyRaw = get('FS_READY');
  let installed = false;
  let schemaVersion: number | null = null;
  let bundleVersion: string | null = null;
  if (readyRaw) {
    try {
      const j = JSON.parse(readyRaw) as { bundleVersion?: string; schemaVersion?: number };
      bundleVersion = j.bundleVersion ?? null;
      schemaVersion = typeof j.schemaVersion === 'number' ? j.schemaVersion : null;
      installed = schemaVersion !== null;
    } catch {
      installed = false;
    }
  }

  return { nodeReady, installed, schemaVersion, bundleVersion, binaryPath, nodeBinaryPath, rgPath };
}
