/**
 * factory.ts(createBinaryProvisioner)emit 时序回归。
 *
 * 背景(2026-07):统一下载器是单槽 FIFO 串行,agent 二进制下载可能在队列里
 * 排在热更 zip 之后。factory 若在 `await download()` 之前就 emit 'downloading',
 * splash 会在排队期间显示一根冻结在 0% 的假进度条;fromCache 命中时还会闪
 * 0→100 假进度。约定:'downloading' 状态只能由传输层真实 onProgress 事件驱动。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import type { VendorRuntimeState } from '../types.js';

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
}));

vi.mock('../../downloader/index.js', () => ({
  download: mocks.download,
  DownloadError: class DownloadError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

const FAKE_SHA = 'a'.repeat(64);

vi.mock('../../manifestService.js', () => ({
  fetchManifest: vi.fn(async () => null),
  getCachedManifest: vi.fn(() => ({ app: {} })),
  getBaseUrl: () => 'https://cdn.test',
}));

vi.mock('../manifest.js', () => ({
  getVendorAsset: () => ({
    version: '9.9.9-test',
    file: 'claude/claude-9.9.9.gz',
    sha256: FAKE_SHA,
    size: 3,
  }),
  resolveVendorAssetUrl: (base: string, asset: { file: string }) => `${base}/${asset.file}`,
}));

import { createBinaryProvisioner } from '../factory.js';

interface DownloadOpts {
  targetPath: string;
  onProgress?: (e: { loaded: number; total: number | null; percent: number | null; speedBps: number }) => void;
}

/** download mock 的成功实现:落一个真实 gzip 让后续解压走通。 */
function fulfillDownload(opts: DownloadOpts, fromCache: boolean): {
  path: string; size: number; sha256: string; fromCache: boolean; durationMs: number; resumedFromBytes: number;
} {
  fs.mkdirSync(path.dirname(opts.targetPath), { recursive: true });
  fs.writeFileSync(opts.targetPath, gzipSync(Buffer.from('bin')));
  return {
    path: opts.targetPath,
    size: 3,
    sha256: FAKE_SHA,
    fromCache,
    durationMs: 1,
    resumedFromBytes: 0,
  };
}

function makeProvisioner() {
  // installSubdir 每个用例唯一,落在 electron-stub 的 tmp userData 下,互不污染。
  return createBinaryProvisioner({
    vendorKey: 'claude',
    manifestField: 'claudeCode',
    installSubdir: `factory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    artifact: { kind: 'gz', binaryName: 'claude-test-bin' },
  });
}

beforeEach(() => {
  mocks.download.mockReset();
});

describe('createBinaryProvisioner emit 时序', () => {
  it('fromCache 命中(download 不产生 onProgress):全程不得 emit downloading', async () => {
    mocks.download.mockImplementation(async (opts: DownloadOpts) => fulfillDownload(opts, true));

    const statuses: Array<VendorRuntimeState['status']> = [];
    const provisioner = makeProvisioner();
    const result = await provisioner.prepare({
      onProgress: (p) => statuses.push(p.status),
    });

    expect(result.ready).toBe(true);
    // 旧实现会在 download() 之前 emit 一次 downloading/0%,造成 splash 假进度条。
    expect(statuses).not.toContain('downloading');
    expect(statuses[statuses.length - 1]).toBe('ready');
  });

  it('真实下载:downloading 只能出现在 download() 的 onProgress 之后(排队期间无事件)', async () => {
    let statusesWhenDownloadInvoked: Array<VendorRuntimeState['status']> = [];
    const statuses: Array<VendorRuntimeState['status']> = [];

    mocks.download.mockImplementation(async (opts: DownloadOpts) => {
      // download() 被调用瞬间 = 任务刚入队(可能在队列里等热更 zip)。
      // 此刻不允许已有任何 downloading emit。
      statusesWhenDownloadInvoked = [...statuses];
      // 模拟排一拍队后传输真正开始,首个进度事件到达。
      await new Promise((r) => setTimeout(r, 10));
      opts.onProgress?.({ loaded: 1, total: 3, percent: 33.3, speedBps: 1024 });
      opts.onProgress?.({ loaded: 3, total: 3, percent: 100, speedBps: 1024 });
      return fulfillDownload(opts, false);
    });

    const provisioner = makeProvisioner();
    const result = await provisioner.prepare({
      onProgress: (p) => statuses.push(p.status),
    });

    expect(result.ready).toBe(true);
    expect(statusesWhenDownloadInvoked).not.toContain('downloading');
    expect(statuses).toContain('downloading');
    expect(statuses[statuses.length - 1]).toBe('ready');
  });
});
