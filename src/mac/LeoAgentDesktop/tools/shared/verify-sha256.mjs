/**
 * verify-sha256 — agent 二进制下载链路的 sha256 校验(纯函数 + 文件级 fail-closed 封装)。
 *
 * 背景:claude / codex / ripgrep 二进制移出 LFS 后改为从上游按需下载(见 tools/<kind>/update.mjs)。
 * 上游若被投毒或 TLS 被剥离,只靠"文件 ≥1KB 且非 LFS pointer"根本拦不住——会静默落地一个
 * 未验证的二进制并以完整 agent 权限执行。终端用户的生产运行时
 * (apps/desktop/src/main/agent-binaries/factory.ts)早已强制 sha256 + size 校验;缺口只在
 * dev / CI / postinstall 这条直连上游的下载链路。本模块提供 fail-closed 的 sha256 校验:算出实际
 * hash 与可信来源比对,不符(或压根拿不到可信 hash)一律抛错,由调用方删除已落地的文件、终止流程。
 *
 * 各 kind 的可信 hash 来源(与生产 / release 信任链同源,均随二进制经同一 TLS 端点下发):
 *   - claude : downloads.claude.ai 的 per-version manifest.json → platforms.<platformKey>.checksum
 *   - codex  : GitHub Release asset 元数据里的 digest 字段("sha256:<hex>",与下载 URL 同一 API 响应)
 *   - ripgrep: GitHub Release 的 .sha256 兄弟资产(tools/ripgrep/update.mjs 原本就已校验,不在本次改动内)
 *
 * 纯 node(被 tools/<kind>/update.mjs 复用)——不依赖 Electron 的 main 进程 downloader。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';

/** 计算 buffer / string 的小写 hex sha256(纯函数,便于单测)。 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 流式计算文件内容的小写 hex sha256。
 * 分块读避免把百 MB 级二进制一次性读进内存(与 ripgrep/update.mjs 的一次性 readFileSync 相比更省内存)。
 */
export function sha256File(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1 << 20); // 1MB 分块
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * 归一化"期望 sha256":接受裸 64-hex 或 GitHub 的 "sha256:<hex>" digest 形式(大小写不敏感),
 * 返回小写 64-hex;不是合法 sha256(缺失 / 长度不对 / 含非法字符 / 非字符串)一律返回 null。
 */
export function normalizeExpectedSha256(expected) {
  if (typeof expected !== 'string') return null;
  const m = expected.trim().toLowerCase().match(/^(?:sha256:)?([0-9a-f]{64})$/);
  return m ? m[1] : null;
}

/**
 * fail-closed 校验:actualHex 必须与 expected(裸 hex 或 "sha256:<hex>")一致。
 * - expected 缺失 / 格式非法 → 抛错(不能静默跳过——"拿不到可信 hash"本身就是要拦截的场景之一);
 * - actual 与 expected 不一致 → 抛错。
 * 成功返回归一化后的期望 hex。纯函数,不碰文件系统。
 */
export function assertSha256({ actualHex, expected, label }) {
  const want = normalizeExpectedSha256(expected);
  if (!want) {
    throw new Error(`Refusing ${label}: no trusted sha256 available to verify against (got ${JSON.stringify(expected ?? null)})`);
  }
  const got = String(actualHex).trim().toLowerCase();
  if (got !== want) {
    throw new Error(`SHA256 mismatch for ${label}: expected ${want}, got ${got}`);
  }
  return want;
}

/**
 * 校验磁盘上已下载的文件;不符 / 拿不到可信 hash → 删除该文件后抛错
 * (fail-closed,绝不把未验证的二进制留在磁盘上给后续 promote / 执行)。
 * 成功返回归一化后的期望 hex。
 */
export function verifyFileSha256OrRemove(filePath, expected, label = filePath) {
  let actualHex;
  try {
    actualHex = sha256File(filePath);
  } catch (err) {
    // 连 hash 都算不出来(文件缺失 / 读失败)——同样按 fail-closed 处理,尽力清理后抛错。
    try { fs.rmSync(filePath, { force: true }); } catch { /* ignore cleanup failure */ }
    throw new Error(`Failed to hash ${label} at ${filePath}: ${err.message}`);
  }
  try {
    return assertSha256({ actualHex, expected, label });
  } catch (err) {
    try { fs.rmSync(filePath, { force: true }); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}
