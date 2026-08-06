#!/usr/bin/env node
/**
 * fix-node-pty-perms — 恢复 node-pty 预编译 `spawn-helper` 的可执行位。
 *
 * 背景（为什么需要这个脚本）：
 *   macOS / Linux 上 node-pty 不直接 spawn 用户 shell，而是先用 `posix_spawn`
 *   拉起一个中转小程序 `spawn-helper`，再由它 exec 真正的 zsh/bash（见 node-pty
 *   `lib/unixTerminal.js`）。这个 helper 必须是可执行文件（0755）。
 *
 *   node-pty 的 npm 包里 `spawn-helper` 本应带 +x 位，但 pnpm 从它的内容寻址 store
 *   硬链接带原生二进制的包时，偶发不保留可执行位，装完变成 0644。结果：终端面板
 *   一创建就报 `[TERMINAL_SPAWN_FAILED] failed to spawn pty: posix_spawnp failed.`
 *   （posix_spawn 对不可执行文件返回 EACCES）。这是 pnpm + node-pty 的已知坑，
 *   只影响 dev 环境——生产包走 electron-rebuild 从源码重编到 build/Release，
 *   编译产物自带正确权限，不吃这份 prebuilds。
 *
 * 本脚本把 dev 环境下的 node-pty `spawn-helper` 补回可执行位（缺 owner execute
 * bit 时 chmod 0755），best-effort、幂等、只在真的缺可执行位时才写、never throw
 * （不阻断 install / dev 启动）。
 *
 * 既可 CLI 跑，也可被 import：
 *   CLI:    node scripts/fix-node-pty-perms.mjs
 *   import: import { fixNodePtyExecutables } from './fix-node-pty-perms.mjs'
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const log = (msg) => console.log(`\x1b[36m[fix-node-pty-perms]\x1b[0m ${msg}`);
const warn = (msg) => console.log(`\x1b[33m[fix-node-pty-perms]\x1b[0m ${msg}`);

/** node-pty 里所有可能承载 spawn-helper 的目录（prebuilds 各平台 + 源码重编产物）。 */
function candidateHelperPaths(nodePtyDir) {
  const paths = [];

  // 1) prebuilds/<platform>-<arch>/spawn-helper —— pnpm 装的预编译产物（dev 主路径）
  const prebuildsDir = path.join(nodePtyDir, 'prebuilds');
  try {
    for (const entry of fs.readdirSync(prebuildsDir)) {
      // win32-* 目录没有 spawn-helper（用 conpty），readdir 命不中就跳过
      paths.push(path.join(prebuildsDir, entry, 'spawn-helper'));
    }
  } catch {
    /* 没有 prebuilds 目录（例如已从源码重编）——跳过 */
  }

  // 2) build/{Release,Debug}/spawn-helper —— node-gyp 从源码重编的产物
  for (const variant of ['Release', 'Debug']) {
    paths.push(path.join(nodePtyDir, 'build', variant, 'spawn-helper'));
  }

  return paths;
}

/**
 * 恢复 node-pty spawn-helper 的可执行位。
 * @returns {{ fixed: string[], skipped: number, platform: string }}
 */
export function fixNodePtyExecutables({ quiet = false } = {}) {
  const result = { fixed: [], skipped: 0, platform: process.platform };

  // Windows 没有 POSIX 可执行位概念，node-pty 走 conpty(.node，require 加载)，无需修复。
  if (process.platform === 'win32') {
    if (!quiet) log('win32：node-pty 用 conpty，无可执行位问题，跳过。');
    return result;
  }

  const nodePtyDir = path.join(ROOT, 'node_modules', 'node-pty');
  if (!fs.existsSync(nodePtyDir)) {
    if (!quiet) warn('未找到 node_modules/node-pty，跳过（尚未 install？）。');
    return result;
  }

  for (const helper of candidateHelperPaths(nodePtyDir)) {
    let mode;
    try {
      const stat = fs.statSync(helper);
      if (!stat.isFile()) continue;
      mode = stat.mode;
    } catch {
      continue; // 不存在（大多数平台目录都命不中）——正常，跳过
    }
    // owner 可执行位已在就不动，避免每次 dev 启动都写盘 / 刷 mtime。
    if (mode & 0o100) {
      result.skipped++;
      continue;
    }
    try {
      fs.chmodSync(helper, 0o755);
      result.fixed.push(path.relative(ROOT, helper));
    } catch (e) {
      // best-effort：补不了也不阻断，只提示（例如只读挂载 / 权限不足）
      if (!quiet) warn(`无法 chmod ${path.relative(ROOT, helper)}：${e.message}`);
    }
  }

  if (!quiet) {
    if (result.fixed.length > 0) {
      log(`已恢复 ${result.fixed.length} 个 spawn-helper 可执行位：${result.fixed.join(', ')}`);
    } else {
      log(`node-pty spawn-helper 权限正常（检查 ${result.skipped} 个）。`);
    }
  }
  return result;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  // never throw：best-effort，任何异常都不该让 install / dev 启动失败。
  try {
    fixNodePtyExecutables();
  } catch (e) {
    warn(`意外错误（忽略）：${e?.message ?? e}`);
  }
}
